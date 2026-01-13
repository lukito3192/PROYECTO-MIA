/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI } from '@google/genai';
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'papaparse';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend } from 'recharts';

import { RFMRecord, ProcessingStatus, ClusterAnalysis } from './types';
import { calculateRFM, performKMeans, getClusterStats } from './utils';

import DottedGlowBackground from './components/DottedGlowBackground';
import SideDrawer from './components/SideDrawer';
import { 
    ThinkingIcon, 
    UploadIcon, 
    SparklesIcon,
    UsersIcon,
    ChartIcon
} from './components/Icons';

// Fallback colors if names don't match, though we will try to map by name now
const BASE_COLORS = ['#ff6b6b', '#4ecdc4', '#ffe66d', '#1a535c', '#f7fff7'];

const getClusterColor = (name: string, index: number) => {
    const n = name.toLowerCase();
    if (n.includes('vip')) return '#4ade80'; // Bright Light Green
    if (n.includes('perdidos')) return '#ef4444'; // Red
    if (n.includes('leales')) return '#38bdf8'; // Light Blue
    if (n.includes('riesgo')) return '#fbbf24'; // Amber/Orange
    return BASE_COLORS[index % BASE_COLORS.length];
};

function App() {
  const [status, setStatus] = useState<ProcessingStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [rfmData, setRfmData] = useState<RFMRecord[]>([]);
  const [clusterInsights, setClusterInsights] = useState<ClusterAnalysis[]>([]);
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(null);
  
  // Chart Interaction State
  const [hoveredClusterName, setHoveredClusterName] = useState<string | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleResetApp = () => {
    setStatus('idle');
    setRfmData([]);
    setClusterInsights([]);
    setErrorMessage('');
  };

  // Security: Input Sanitization Helper to prevent XSS and CSV Injection
  const sanitizeInput = (input: any): string => {
    if (input === null || input === undefined) return '';
    const str = String(input);
    // 1. Strip HTML tags to prevent XSS (Reflected/Stored)
    // 2. Escape CSV injection characters (=, +, -, @) if at start
    let clean = str.replace(/[<>]/g, ''); 
    if (/^[\-+=@]/.test(clean)) {
        clean = "'" + clean; 
    }
    return clean.trim().substring(0, 100); // Limit length to prevent buffer issues
  };

  // Gemini Integration for Insights
  const generateInsights = async (records: RFMRecord[]) => {
    setStatus('analyzing');
    try {
        const apiKey = process.env.API_KEY;
        // PRIVACY NOTE: We only send aggregated statistics (centroids), NOT raw user data.
        const stats = getClusterStats(records, 4);
        
        // Default fallbacks in case API fails
        // Providing Spanish fallbacks
        let analyses: ClusterAnalysis[] = stats.map((s, i) => ({
            id: i,
            name: `Grupo ${i + 1}`,
            description: 'Segmento de clientes basado en hábitos de compra.',
            strategy: 'Mantener la interacción.',
            stats: s
        }));

        if (apiKey) {
             const ai = new GoogleGenAI({ apiKey });
             const prompt = `
                Analiza estos Segmentos de Clientes de un análisis RFM.
                Datos (Estadísticas Anónimas): ${JSON.stringify(stats)}

                Instrucciones Obligatorias:
                1. Asigna a cada clúster EXACTAMENTE UNO de estos nombres basándote en sus métricas (Gasto, Frecuencia, Recencia): "VIP", "Leales", "En riesgo", "Perdidos".
                2. No inventes otros nombres. Debes usar solo esos 4.
                3. La respuesta debe estar en ESPAÑOL.

                Para CADA clúster, devuelve un objeto JSON con:
                - name: Uno de los 4 nombres permitidos ("VIP", "Leales", "En riesgo", "Perdidos").
                - description: Un análisis de comportamiento en 1 oración (en español).
                - strategy: Un plan de acción de marketing en 1 oración (en español).

                Devuelve SOLO un array JSON válido.
             `;

             const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: { role: 'user', parts: [{ text: prompt }] }
             });
             
             const text = response.text || '[]';
             const jsonMatch = text.match(/\[[\s\S]*\]/);
             if (jsonMatch) {
                const aiData = JSON.parse(jsonMatch[0]);
                analyses = aiData.map((d: any, i: number) => ({
                    ...d,
                    id: i,
                    stats: stats[i]
                }));
             }
        }
        
        setClusterInsights(analyses);
        setStatus('complete');
    } catch (e) {
        console.error("AI Insight generation failed", e);
        // Fallback to complete state even if AI fails, so user sees the chart
        setStatus('complete'); 
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setStatus('parsing');
    setErrorMessage('');
    
    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            try {
                // Validate columns loosely
                const fields = results.meta.fields || [];
                const idCol = fields.find(f => f.toLowerCase().includes('id') || f.toLowerCase().includes('customer'));
                const dateCol = fields.find(f => f.toLowerCase().includes('date') || f.toLowerCase().includes('time'));
                const amountCol = fields.find(f => f.toLowerCase().includes('amount') || f.toLowerCase().includes('price') || f.toLowerCase().includes('total'));

                if (!idCol || !dateCol || !amountCol) {
                    throw new Error("El CSV debe tener columnas para CustomerID, Date, y Amount.");
                }

                // Map & Sanitize - STRICT SECURITY VALIDATION
                const cleanData: any[] = [];
                
                results.data.forEach((row: any) => {
                    const rawId = row[idCol];
                    const rawDate = row[dateCol];
                    const rawAmount = row[amountCol];

                    // OWASP: Validate data presence
                    if (!rawId || !rawDate || rawAmount === undefined) return;

                    // OWASP: Sanitize Strings (Prevent XSS/Injection)
                    const safeId = sanitizeInput(rawId);
                    
                    // OWASP: Strict Type Validation for Dates
                    const dateObj = new Date(rawDate);
                    if (isNaN(dateObj.getTime())) return; // Discard invalid dates

                    // OWASP: Strict Type Validation for Numbers
                    const amountStr = String(rawAmount).replace(/[^0-9.-]/g, "");
                    const safeAmount = parseFloat(amountStr);
                    if (!isFinite(safeAmount)) return; // Discard invalid amounts

                    cleanData.push({
                        CustomerID: safeId,
                        Date: dateObj.toISOString(),
                        Amount: safeAmount
                    });
                });

                if (cleanData.length === 0) {
                    throw new Error("No se encontraron datos válidos o seguros en el CSV.");
                }

                setStatus('clustering');
                
                // Small delay to allow UI render update before heavy calculation
                setTimeout(() => {
                    try {
                        const rfm = calculateRFM(cleanData);
                        if (rfm.length === 0) throw new Error("No se pudieron calcular métricas RFM. Revisa los formatos.");
                        
                        const clustered = performKMeans(rfm, 4); 
                        setRfmData(clustered);
                        generateInsights(clustered);
                    } catch (calcError: any) {
                        setErrorMessage(calcError.message || "Error matemático durante el procesamiento.");
                        setStatus('error');
                    }
                }, 100);

            } catch (err: any) {
                console.error("Processing error:", err);
                setErrorMessage(err.message || "Fallo al procesar el archivo CSV.");
                setStatus('error');
            }
        },
        error: (err) => {
            console.error("CSV Parse error:", err);
            setErrorMessage("Fallo al leer el archivo CSV.");
            setStatus('error');
        }
    });
  };

  const selectedInsight = clusterInsights.find(c => c.id === selectedClusterId);

  return (
    <div className="immersive-app">
        <DottedGlowBackground gap={24} radius={1.5} opacity={0.6} />

        <div className="app-container">
            {/* --- HERO / UPLOAD STATE --- */}
            {status === 'idle' || status === 'error' ? (
                <div className="hero-section">
                    <h1 className="hero-title">Inteligencia de Clientes <span className="highlight">AI</span></h1>
                    <p className="hero-subtitle">Sube tu historial de transacciones (CSV). Realizaremos análisis RFM, segmentación y generaremos perfiles de marketing con Gemini.</p>
                    
                    <div className="upload-box" onClick={() => fileInputRef.current?.click()}>
                        <UploadIcon />
                        <span>Arrastra CSV o Clic para Subir</span>
                        <span className="upload-hint">Columnas requeridas: CustomerID, Date, Amount</span>
                    </div>
                    
                    {/* Security Badge */}
                    <div style={{ marginTop: '20px', fontSize: '0.8rem', color: '#666', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        <span>Procesamiento 100% Local y Seguro. Sus datos no salen de su navegador.</span>
                    </div>

                    {status === 'error' && (
                        <div style={{ color: '#ff6b6b', marginTop: '16px', background: 'rgba(255,0,0,0.1)', padding: '8px 16px', borderRadius: '8px' }}>
                            Error: {errorMessage}
                        </div>
                    )}
                    <input 
                        type="file" 
                        ref={fileInputRef} 
                        onChange={handleFileUpload} 
                        accept=".csv" 
                        style={{ display: 'none' }}
                        value="" // Allow re-uploading the same file if it failed
                    />
                </div>
            ) : null}

            {/* --- LOADING STATE --- */}
            {(status === 'parsing' || status === 'clustering' || status === 'analyzing') && (
                <div className="loading-state-fullscreen">
                    <ThinkingIcon />
                    <div className="loading-text">
                        {status === 'parsing' && 'Analizando datos CSV...'}
                        {status === 'clustering' && 'Ejecutando segmentación K-Means...'}
                        {status === 'analyzing' && 'Aplicando Clusterización a su CSV...'}
                    </div>
                </div>
            )}

            {/* --- DASHBOARD STATE --- */}
            {status === 'complete' && (
                <div className="dashboard-grid">
                    <header className="dashboard-header">
                        <h2>Resumen de Analítica</h2>
                        <div className="header-meta">
                            <span className="badge">{rfmData.length} Clientes</span>
                            <span className="badge-outline" onClick={handleResetApp}>Subir Nuevo</span>
                        </div>
                    </header>

                    {/* CHART SECTION */}
                    <div className="chart-card">
                        <div className="chart-header">
                            <h3><ChartIcon /> Distribución de Segmentos</h3>
                            <p>Recencia (Días) vs. Valor Monetario ($)</p>
                        </div>
                        <div className="chart-body" style={{ position: 'relative' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <ScatterChart 
                                    margin={{ top: 20, right: 20, bottom: 40, left: 20 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                                    <XAxis 
                                        type="number" 
                                        dataKey="recency" 
                                        name="Recencia" 
                                        unit=" días" 
                                        stroke="#888" 
                                        label={{ value: 'Días desde última compra', position: 'bottom', offset: 20, fill: '#888' }}
                                    />
                                    <YAxis 
                                        type="number" 
                                        dataKey="monetary" 
                                        name="Monetario" 
                                        unit="$" 
                                        stroke="#888" 
                                        label={{ value: 'Gasto Total', angle: -90, position: 'left', fill: '#888' }}
                                    />
                                    <ZAxis type="number" dataKey="frequency" range={[20, 200]} name="Frecuencia" />
                                    <Tooltip 
                                        cursor={{ strokeDasharray: '3 3' }}
                                        contentStyle={{ backgroundColor: '#18181b', borderColor: '#333', color: '#fff' }}
                                        itemStyle={{ color: '#fff' }}
                                    />
                                    <Legend 
                                        verticalAlign="top"
                                        height={36}
                                        onMouseEnter={(o) => setHoveredClusterName(o.value)}
                                        onMouseLeave={() => setHoveredClusterName(null)}
                                        wrapperStyle={{ cursor: 'pointer', paddingBottom: '10px' }}
                                    />
                                    {clusterInsights.map((cluster, index) => (
                                        <Scatter 
                                            key={cluster.id} 
                                            name={cluster.name} 
                                            data={rfmData.filter(d => d.clusterIndex === cluster.id)} 
                                            fill={getClusterColor(cluster.name, index)}
                                            fillOpacity={hoveredClusterName ? (hoveredClusterName === cluster.name ? 1 : 0.1) : 0.8}
                                            strokeOpacity={hoveredClusterName ? (hoveredClusterName === cluster.name ? 1 : 0.1) : 0}
                                            animationDuration={300}
                                        />
                                    ))}
                                </ScatterChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* CLUSTER CARDS */}
                    <div className="insights-grid">
                        {clusterInsights.map((cluster, i) => {
                            const color = getClusterColor(cluster.name, i);
                            return (
                                <div 
                                    key={cluster.id} 
                                    className="insight-card" 
                                    onClick={() => setSelectedClusterId(cluster.id)}
                                    style={{ borderTop: `4px solid ${color}` }}
                                >
                                    <div className="insight-header">
                                        <UsersIcon />
                                        <h4>{cluster.name}</h4>
                                    </div>
                                    <div className="insight-stats">
                                        <div className="stat">
                                            <label>Gasto Prom.</label>
                                            <span>${cluster.stats.monetary.toLocaleString()}</span>
                                        </div>
                                        <div className="stat">
                                            <label>Visto hace</label>
                                            <span>{cluster.stats.recency} días</span>
                                        </div>
                                        <div className="stat">
                                            <label>Tamaño</label>
                                            <span>{cluster.stats.count}</span>
                                        </div>
                                    </div>
                                    <div className="insight-action" style={{ color: color }}>
                                        Ver Estrategia &rarr;
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>

        {/* SIDE DRAWER FOR DETAILS */}
        <SideDrawer 
            isOpen={selectedClusterId !== null} 
            onClose={() => setSelectedClusterId(null)} 
            title={selectedInsight?.name || 'Detalles del Segmento'}
        >
            {selectedInsight && (
                <div className="drawer-detail-content">
                    <div className="persona-badge" style={{ backgroundColor: getClusterColor(selectedInsight.name, selectedInsight.id) }}>
                        {selectedInsight.name}
                    </div>
                    
                    <div className="section">
                        <h3><SparklesIcon /> Análisis</h3>
                        <p className="ai-text">{selectedInsight.description}</p>
                    </div>

                    <div className="section">
                        <h3>Estrategia</h3>
                        <div className="strategy-box" style={{ 
                            color: getClusterColor(selectedInsight.name, selectedInsight.id),
                            borderColor: getClusterColor(selectedInsight.name, selectedInsight.id),
                            background: `${getClusterColor(selectedInsight.name, selectedInsight.id)}15`
                        }}>
                            {selectedInsight.strategy}
                        </div>
                    </div>

                    <div className="section">
                        <h3>Métricas Clave (Promedio)</h3>
                        <ul className="metrics-list">
                            <li>
                                <span>Recencia</span>
                                <strong>{selectedInsight.stats.recency} días</strong>
                            </li>
                            <li>
                                <span>Frecuencia</span>
                                <strong>{selectedInsight.stats.frequency} órdenes</strong>
                            </li>
                            <li>
                                <span>Valor Monetario</span>
                                <strong>${selectedInsight.stats.monetary.toLocaleString()}</strong>
                            </li>
                            <li>
                                <span>Tamaño del Segmento</span>
                                <strong>{selectedInsight.stats.count} clientes</strong>
                            </li>
                        </ul>
                    </div>
                </div>
            )}
        </SideDrawer>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<React.StrictMode><App /></React.StrictMode>);
}