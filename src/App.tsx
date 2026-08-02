import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ClipboardPaste, RefreshCw, AlertCircle, CheckCircle2, ChevronDown, Plus, Trash2, Download } from 'lucide-react';
import { db, firestore } from './lib/firebase';
import { ref, onValue, set, update, get } from 'firebase/database';
import { collection, addDoc, writeBatch, doc } from 'firebase/firestore';

// --- TSV Parser Helper ---
// Safely parses TSV data that might have been copied from Excel with intra-cell newlines (wrapped in quotes)
function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentCell += '"'; // Escaped quote
          i++;
        } else {
          inQuotes = false; // End of quoted section
        }
      } else {
        currentCell += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === '\t') {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else if (char === '\n') {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else if (char !== '\r') {
        currentCell += char;
      }
    }
  }
  if (currentRow.length > 0 || currentCell !== '') {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }
  return rows.filter(row => row.some(cell => cell !== '')); // Remove completely empty rows
}

// --- Initial Manual Data ---
const initialArmazenagem = [
  { name: 'ACHOCOLATADO', value: 0 },
  { name: 'AMÊNDOAS', value: 0 },
  { name: 'CAFE ALTO GIRO', value: 0 },
  { name: 'CAFE BAIXO GIRO', value: 0 },
  { name: 'CAPPUCCINOS', value: 0 },
  { name: 'CAPSULAS', value: 0 },
  { name: 'COMPOSTO', value: 0 },
  { name: 'EXPRESSO', value: 0 },
  { name: 'FILTROS', value: 0 },
  { name: 'MAQUINAS', value: 0 },
  { name: 'PRONTO', value: 0 },
  { name: 'REFRESCO', value: 0 },
  { name: 'SOLUVEIS', value: 0 },
  { name: 'XICARA', value: 0 },
  { name: 'GERAL', value: 0 },
];

const initialPaletes = [
  { name: 'PALETES PATIO', value: 0 },
  { name: 'PALETES STAGE', value: 0 },
  { name: 'PALETES ROBO', value: 0 },
  { name: 'PALETES DESCARGA', value: 0 },
  { name: 'PALETES REFORMA', value: 0 },
];

const initialOrganizacao = [
  ...Array.from({ length: 13 }, (_, i) => ({ name: `RUA ${String(i + 1).padStart(2, '0')}`, value: 'OK' })),
  { name: 'ÁREA DE PALETES', value: 'OK' },
  { name: 'DOCAS', value: 'OK' },
];


export default function App() {
  const [pastedData, setPastedData] = useState('');
  const [statusMessage, setStatusMessage] = useState({ text: '', type: '' });

  // --- LocalStorage Fallback Helpers ---
  const loadLocal = (key: string, defaultValue: any) => {
    try {
      const stored = localStorage.getItem(`statusLider_${key}`);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  };

  const saveLocal = (data: any) => {
    try {
      Object.entries(data).forEach(([key, val]) => {
        localStorage.setItem(`statusLider_${key}`, JSON.stringify(val));
      });
    } catch (e) {
      console.warn("Could not save to localStorage", e);
    }
  };
  
  // Operator Menu States
  const [operators, setOperators] = useState<string[]>(() => loadLocal('operators', ['OPERACIONAL', 'DANIEL', 'THAIS', 'VALDINEI', 'FRED']));
  const [selectedOperator, setSelectedOperator] = useState<string>(() => loadLocal('selectedOperator', 'OPERACIONAL'));
  const [showOperatorMenu, setShowOperatorMenu] = useState(false);
  const [newOperatorName, setNewOperatorName] = useState('');
  
  // Calculated States
  const [stats, setStats] = useState(() => loadLocal('stats', {
    interestadual: { programado: 0, finalizado: 0, emAndamento: 0, pendente: 0 },
    vespasiano: { programado: 0, finalizado: 0, emAndamento: 0, pendente: 0 }
  }));

  // Manual States
  const [descarga, setDescarga] = useState(() => loadLocal('descarga', { programado: 0, finalizado: 0, emAndamento: 0, pendente: 0 }));
  const [armazenagem, setArmazenagem] = useState(() => loadLocal('armazenagem', initialArmazenagem));
  const [paletes, setPaletes] = useState(() => loadLocal('paletes', initialPaletes));
  const [organizacao, setOrganizacao] = useState(() => loadLocal('organizacao', initialOrganizacao));

  // Today's date formatted
  const todayDate = new Date().toLocaleDateString('pt-BR');

  // PWA Install State
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallBtn, setShowInstallBtn] = useState(false);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBtn(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setShowInstallBtn(false);
      }
      setDeferredPrompt(null);
    }
  };

  // --- Firebase Sync Logic ---
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isIncomingSync = useRef(false);
  const pendingUpdates = useRef<any>({});

  // Sync from Firebase
  useEffect(() => {
      const dbRef = ref(db, 'historico/statusLider');
      
      // Perform initial fetch
      get(dbRef).then((snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.val();
          console.log("Firebase: Initial fetch full data:", JSON.stringify(data, null, 2));
          isIncomingSync.current = true;
          
          if (data.operators) setOperators(data.operators);
          if (data.selectedOperator) setSelectedOperator(data.selectedOperator);
          if (data.stats) setStats(data.stats);
          if (data.descarga) setDescarga(data.descarga);
          if (data.armazenagem) setArmazenagem(data.armazenagem);
          if (data.paletes) setPaletes(data.paletes);
          if (data.organizacao) setOrganizacao(data.organizacao);
          
          setTimeout(() => { isIncomingSync.current = false; }, 100);
        } else {
          console.log("Firebase: No data exists at initial fetch.");
        }
      }).catch(console.error);

      // Listen for updates
      const unsub = onValue(dbRef, (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.val();
          console.log("Firebase: Listener update full data:", JSON.stringify(data, null, 2));
          isIncomingSync.current = true;
          
          if (data.operators) setOperators(data.operators);
          if (data.selectedOperator) setSelectedOperator(data.selectedOperator);
          if (data.stats) setStats(data.stats);
          if (data.descarga) setDescarga(data.descarga);
          if (data.armazenagem) setArmazenagem(data.armazenagem);
          if (data.paletes) setPaletes(data.paletes);
          if (data.organizacao) setOrganizacao(data.organizacao);
          
          setTimeout(() => { isIncomingSync.current = false; }, 100);
        }
      }, (err) => {
        console.error("Firebase Sync Error: ", err);
      });
      return () => { if (unsub) unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleUpdate = (partialData: any) => {
    // Save to localStorage immediately to guarantee local persistence
    saveLocal(partialData);

    if (isIncomingSync.current) return;
    
    // Acumula os dados para evitar perda em edições muito rápidas
    pendingUpdates.current = { ...pendingUpdates.current, ...partialData };

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const dataToSave = { ...pendingUpdates.current };
      pendingUpdates.current = {}; // Limpa

      update(ref(db, 'historico/statusLider'), dataToSave)
        .catch(err => {
            console.warn('Erro ao salvar no Firebase (esperado se regras não configuradas): ', err);
            setStatusMessage({ text: 'Falha ao sincronizar com nuvem. Dados salvos localmente.', type: 'error' });
        });
    }, 500);
  };

  const [isProcessingAI, setIsProcessingAI] = useState(false);

  // --- AI Extraction Functions ---
  // --- Local Data Extraction Functions ---
  function processarTextoSemIA(textoPlanilha: string) {
    const linhas = textoPlanilha.trim().split(/\r?\n/);
    if (linhas.length < 2) return [];

    // Pega os cabeçalhos da 1ª linha
    const cabecalhos = linhas[0].split('\t').map(c => c.trim());

    // Converte TODAS as linhas em objetos JSON
    return linhas.slice(1).map(linha => {
      const valores = linha.split('\t');
      const objeto: any = {};

      cabecalhos.forEach((cabecalho, index) => {
        objeto[cabecalho] = valores[index] ? valores[index].trim() : "";
      });

      return objeto;
    });
  }

  async function salvarNoFirebaseEmLotes(listaDeDados: any[], nomeColecao = "minhas_informacoes") {
    const LIMITE_LOTE = 500;
    for (let i = 0; i < listaDeDados.length; i += LIMITE_LOTE) {
      const loteAtual = listaDeDados.slice(i, i + LIMITE_LOTE);
      const batch = writeBatch(firestore);

      loteAtual.forEach((item) => {
        const novoDocRef = doc(collection(firestore, nomeColecao));
        batch.set(novoDocRef, item);
      });

      await batch.commit();
      console.log(`Progresso: ${Math.min(i + LIMITE_LOTE, listaDeDados.length)} / ${listaDeDados.length} salvos.`);
    }
  }

  const importarPlanilhaCompleta = async () => {
    if (!pastedData.trim()) {
      setStatusMessage({ text: 'Por favor, cole os dados da planilha antes de continuar.', type: 'error' });
      return;
    }

    setIsProcessingAI(true);
    setStatusMessage({ text: 'Extraindo dados...', type: '' });

    try {
      const dadosExtraidos = processarTextoSemIA(pastedData);
      
      if (dadosExtraidos.length === 0) {
        throw new Error("Nenhum dado encontrado ou cabeçalhos inválidos.");
      }

      setStatusMessage({ text: `Extraídos ${dadosExtraidos.length} registros. Salvando no Firestore...`, type: '' });
      
      await salvarNoFirebaseEmLotes(dadosExtraidos, "minhas_informacoes");
      
      setStatusMessage({ text: `Sucesso! Foram salvos ${dadosExtraidos.length} itens no Firestore.`, type: 'success' });
      // Clear after success
      setPastedData('');
    } catch (error: any) {
      console.error("Erro no processo de importação:", error);
      setStatusMessage({ text: `Falha: ${error.message || 'Erro desconhecido'}`, type: 'error' });
    } finally {
      setIsProcessingAI(false);
    }
  };

  // --- Local Processing ---
  const processData = () => {
    if (!pastedData.trim()) {
      setStatusMessage({ text: 'Cole os dados da planilha primeiro.', type: 'error' });
      return;
    }

    const rows = parseTSV(pastedData);
    console.log("processData rows:", rows);
    if (rows.length === 0) {
      setStatusMessage({ text: 'Dados insuficientes.', type: 'error' });
      return;
    }

    // Normalize headers for flexible matching
    const headers = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    console.log("processData headers:", headers);
    
    // Find column indices
    let destIdx = headers.findIndex(h => h.includes('destino'));
    let docaIdx = headers.findIndex(h => h === 'doca' || h === 'do ca');
    let libIdx = headers.findIndex(h => h.includes('libdoc') || h === 'libdoca' || h.includes('libera'));
    console.log(`Indices: dest=${destIdx}, doca=${docaIdx}, lib=${libIdx}`);

    let startRow = 1;

    // Se as colunas não forem encontradas pelo cabeçalho, provavelmente colaram sem cabeçalho.
    // Usamos os índices baseados no exemplo fornecido pelo usuário.
    if (destIdx === -1 || docaIdx === -1 || libIdx === -1) {
      startRow = 0; // Começa da primeira linha pois não tem cabeçalho
      destIdx = 6;  // Coluna G: Destino
      docaIdx = 15; // Coluna P: Doca
      libIdx = 17;  // Coluna R: Lib Doca?
    }

    let intProg = 0, intFin = 0, intAnd = 0, intPend = 0;
    let vespProg = 0, vespFin = 0, vespAnd = 0, vespPend = 0;

    // Start from row startRow
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];
      
      // Ensure we have a valid destination to process the row
      const destinoText = (row[destIdx] || '').trim().toUpperCase();
      if (!destinoText) continue; 

      const isVespasiano = destinoText.includes('VESPASIANO');
      const docaVal = (row[docaIdx] || '').trim();
      const libVal = (row[libIdx] || '').trim().toUpperCase();

      let status = 'PENDENTE';
      
      // Lógica de status:
      // 1. Se Lib Doca é "SIM", é Finalizado
      // 2. Senão se Doca preenchida, é Em Andamento
      // 3. Caso contrário, Pendente
      if (libVal === 'SIM' || libVal === 'S') {
        status = 'FINALIZADO';
      } else if (docaVal !== '') {
        status = 'EM_ANDAMENTO';
      }

      // Adiciona no grupo correspondente
      if (isVespasiano) {
        vespProg++;
        if (status === 'FINALIZADO') vespFin++;
        else if (status === 'EM_ANDAMENTO') vespAnd++;
        else vespPend++;
      } else {
        intProg++;
        if (status === 'FINALIZADO') intFin++;
        else if (status === 'EM_ANDAMENTO') intAnd++;
        else intPend++;
      }
    }

    const newStats = {
      interestadual: { programado: intProg, finalizado: intFin, emAndamento: intAnd, pendente: intPend },
      vespasiano: { programado: vespProg, finalizado: vespFin, emAndamento: vespAnd, pendente: vespPend }
    };

    setStats(newStats);
    scheduleUpdate({ stats: newStats });

    setStatusMessage({ text: `Sucesso! Foram processadas ${intProg + vespProg} carretas.`, type: 'success' });
  };

  const handleStatsChange = (group: 'interestadual' | 'vespasiano', key: keyof typeof stats['interestadual'], value: string) => {
    setStats(prev => {
      const nextStats = {
        ...prev,
        [group]: {
          ...prev[group],
          [key]: parseInt(value) || 0
        }
      };
      scheduleUpdate({ stats: nextStats });
      return nextStats;
    });
  };

  const handleDescargaChange = (key: keyof typeof descarga, value: string) => {
    setDescarga(prev => {
      const next = { ...prev, [key]: parseInt(value) || 0 };
      scheduleUpdate({ descarga: next });
      return next;
    });
  };

  const updateArrayValue = (setter: React.Dispatch<React.SetStateAction<any[]>>, stateKey: string, index: number, value: string | number) => {
    setter(prev => {
      const newArr = [...prev];
      newArr[index] = { ...newArr[index], value };
      scheduleUpdate({ [stateKey]: newArr });
      return newArr;
    });
  };

  const totalArmazenagem = useMemo(() => armazenagem.reduce((acc, obj) => acc + Number(obj.value), 0), [armazenagem]);
  const totalPaletes = useMemo(() => paletes.reduce((acc, obj) => acc + Number(obj.value), 0), [paletes]);

  return (
    <div className="min-h-screen bg-slate-200 text-slate-800 font-sans p-2 md:p-4 flex flex-col items-center justify-start">
      <div className="max-w-[1240px] w-full mx-auto space-y-3 flex flex-col">
        
        {/* --- Input Section --- */}
        <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-300 shrink-0">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1 text-slate-700 font-bold">
                <ClipboardPaste className="w-4 h-4 text-blue-600" />
                <h2 className="text-sm">Colar Dados da Planilha</h2>
              </div>
              <textarea
                className="w-full h-16 p-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none placeholder-slate-400 shadow-inner"
                placeholder="Cole as informações do Excel/Sheets aqui..."
                value={pastedData}
                onChange={(e) => setPastedData(e.target.value)}
              />
            </div>
            <div className="sm:w-48 flex flex-col gap-2 justify-end">
              <div className="flex flex-col gap-2">
                <button
                  onClick={processData}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded shadow-sm text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  PROCESSAR DADOS
                </button>
                <button
                  onClick={importarPlanilhaCompleta}
                  disabled={isProcessingAI}
                  className={`w-full ${isProcessingAI ? 'bg-slate-400' : 'bg-emerald-600 hover:bg-emerald-700'} text-white font-bold py-2 rounded shadow-sm text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isProcessingAI ? 'animate-spin' : ''}`} />
                  IMPORTAR TUDO (FIRESTORE)
                </button>
              </div>
              {statusMessage.text && (
                <div className={`w-full flex items-center justify-center gap-1.5 text-xs font-bold px-2 py-1.5 border rounded ${statusMessage.type === 'error' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                  {statusMessage.type === 'error' ? <AlertCircle className="w-3.5 h-3.5 shrink-0" /> : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
                  <span className="truncate" title={statusMessage.text}>{statusMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* --- Dashboard Rendering --- */}
        <div className="bg-white rounded-xl border border-slate-300 shadow-xl flex flex-col overflow-hidden shrink-0">
          {/* Main Header */}
          <header className="h-12 bg-blue-900 flex items-center justify-between px-2 sm:px-4 shrink-0 shadow-sm z-10 min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
              <div className="hidden min-[360px]:flex w-6 h-6 sm:w-7 sm:h-7 bg-white rounded items-center justify-center shadow-sm shrink-0">
                 <ClipboardPaste className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-900" />
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
                <h1 className="text-sm sm:text-lg font-bold text-white tracking-tight shrink-0 whitespace-nowrap">Status Lider</h1>
                <div className="relative inline-block min-w-0">
                  <button 
                    onClick={() => setShowOperatorMenu(!showOperatorMenu)}
                    className="text-sm sm:text-lg font-bold text-white tracking-tight flex items-center gap-0.5 sm:gap-1 hover:text-slate-200 transition-colors cursor-pointer min-w-0 text-left focus:outline-none"
                    title={selectedOperator}
                  >
                    <span className="shrink-0 whitespace-nowrap">-</span>
                    <span className="truncate max-w-[80px] min-[380px]:max-w-[120px] md:max-w-[200px] inline-block align-bottom notranslate" translate="no">{selectedOperator}</span>
                    <ChevronDown className="w-3.5 h-3.5 sm:w-5 sm:h-5 opacity-80 shrink-0" />
                  </button>
                  
                  {showOperatorMenu && (
                    <div className="absolute top-full left-0 mt-2 w-56 bg-white rounded-lg shadow-xl border border-slate-200 z-50 text-slate-800 font-sans text-sm font-normal overflow-hidden animate-in fade-in duration-200" style={{ transformOrigin: 'top left' }}>
                      <div className="max-h-48 overflow-y-auto p-1">
                        {operators.map((op, idx) => (
                           <div key={`${op}-${idx}`} className="flex justify-between items-center px-3 py-2 hover:bg-slate-100 rounded-md group">
                             <span 
                               className="cursor-pointer flex-1 font-semibold text-slate-700 uppercase notranslate" 
                               translate="no"
                               onClick={() => { setSelectedOperator(op); scheduleUpdate({ selectedOperator: op }); setShowOperatorMenu(false); }}
                             >
                               {op}
                             </span>
                             {operators.length > 1 && (
                               <button 
                                 onClick={(e) => {
                                   e.stopPropagation();
                                   const newOps = operators.filter((_, i) => i !== idx);
                                   setOperators(newOps);
                                   let newSelected = selectedOperator;
                                   if (selectedOperator === op) {
                                      newSelected = newOps[0] || '';
                                      setSelectedOperator(newSelected);
                                   }
                                   scheduleUpdate({ operators: newOps, selectedOperator: newSelected });
                                 }} 
                                 className="text-slate-400 hover:text-red-600 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity p-1 cursor-pointer"
                                 title="Remover"
                               >
                                 <Trash2 className="w-3.5 h-3.5" />
                               </button>
                             )}
                           </div>
                        ))}
                      </div>
                      <div className="border-t border-slate-200 p-2 flex gap-2 bg-slate-50">
                         <input 
                           type="text" 
                           value={newOperatorName} 
                           onChange={e => setNewOperatorName(e.target.value)} 
                           placeholder="Ex: JOÃO" 
                           className="flex-1 w-full text-xs px-2 py-1.5 border border-slate-300 rounded focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none uppercase font-semibold text-slate-700 notranslate" translate="no" autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck="false"
                           onKeyDown={e => {
                             if (e.key === 'Enter' && newOperatorName.trim()) {
                               const newOps = [...operators, newOperatorName.trim().toUpperCase()];
                               setOperators(newOps);
                               scheduleUpdate({ operators: newOps });
                               setNewOperatorName('');
                             }
                           }}
                         />
                         <button 
                           onClick={() => {
                             if (newOperatorName.trim()) {
                               const newOps = [...operators, newOperatorName.trim().toUpperCase()];
                               setOperators(newOps);
                               scheduleUpdate({ operators: newOps });
                               setNewOperatorName('');
                             }
                           }}
                           className="bg-blue-600 text-white rounded px-2 hover:bg-blue-700 transition-colors flex items-center justify-center cursor-pointer"
                           title="Adicionar"
                         >
                           <Plus className="w-4 h-4" />
                         </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2 sm:gap-3 items-center shrink-0">
              {showInstallBtn && (
                <button
                   onClick={handleInstallClick}
                   className="flex text-[10px] sm:text-xs font-bold text-white bg-blue-700 hover:bg-blue-600 px-2 py-1 sm:py-1.5 rounded items-center gap-1 transition-colors border border-blue-500 shadow-sm whitespace-nowrap"
                >
                   <Download className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                   <span className="hidden min-[360px]:inline">Instalar</span>
                </button>
              )}
              <div className="text-blue-200 text-[10px] sm:text-xs text-right leading-tight">
                <p className="font-bold">{todayDate}</p>
                <p className="opacity-70 uppercase tracking-wider text-[8px] sm:text-[9px]">Santa Luzia</p>
              </div>
            </div>
          </header>

          <main className="p-2 sm:p-4 bg-slate-50 flex flex-col gap-3 sm:gap-4 rounded-b-lg">
            
            {/* --- CARRETAS ROW --- */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
              {/* INTERESTADUAL (Auto) */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                <div className="p-2 sm:p-2.5 bg-slate-800 text-white">
                  <h2 className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-center">Interestadual</h2>
                </div>
                <div className="flex-1 p-1 sm:p-1.5 space-y-0.5 sm:space-y-1">
                  {(['programado', 'finalizado', 'emAndamento', 'pendente'] as const).map((key) => (
                    <div key={key} className="flex justify-between items-center px-2 py-0.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 rounded transition-colors bg-white">
                      <span className="text-[10px] sm:text-xs font-bold text-slate-600 uppercase">{key === 'emAndamento' ? 'EM ANDAMENTO' : key}</span>
                      <input 
                        type="number"
                        min="0"
                        className="w-12 sm:w-16 h-7 text-center font-black text-xs sm:text-sm border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded outline-none bg-slate-50 hover:bg-white transition-colors text-slate-800"
                        value={stats.interestadual[key] || 0}
                        onChange={(e) => handleStatsChange('interestadual', key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* VESPASIANO (Auto) */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                <div className="p-2 sm:p-2.5 bg-amber-600 text-white">
                  <h2 className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-center">Transf. Vespasiano</h2>
                </div>
                <div className="flex-1 p-1 sm:p-1.5 space-y-0.5 sm:space-y-1">
                  {(['programado', 'finalizado', 'emAndamento', 'pendente'] as const).map((key) => (
                    <div key={key} className="flex justify-between items-center px-2 py-0.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 rounded transition-colors bg-white">
                      <span className="text-[10px] sm:text-xs font-bold text-slate-600 uppercase">{key === 'emAndamento' ? 'EM ANDAMENTO' : key}</span>
                      <input 
                        type="number"
                        min="0"
                        className="w-12 sm:w-16 h-7 text-center font-black text-xs sm:text-sm border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded outline-none bg-slate-50 hover:bg-white transition-colors text-slate-800"
                        value={stats.vespasiano[key] || 0}
                        onChange={(e) => handleStatsChange('vespasiano', key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* DESCARGA (Manual) */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                <div className="p-2 sm:p-2.5 bg-emerald-600 text-white">
                  <h2 className="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-center">Descarga</h2>
                </div>
                <div className="flex-1 p-1 sm:p-1.5 space-y-0.5 sm:space-y-1">
                  {(['programado', 'finalizado', 'emAndamento', 'pendente'] as const).map((key) => (
                    <div key={key} className="flex justify-between items-center px-2 py-0.5 border-b border-slate-100 last:border-0 hover:bg-slate-50 rounded transition-colors bg-white">
                      <span className="text-[10px] sm:text-xs font-bold text-slate-600 uppercase">{key === 'emAndamento' ? 'EM ANDAMENTO' : key}</span>
                      <input 
                        type="number"
                        min="0"
                        className="w-12 sm:w-16 h-7 text-center font-black text-xs sm:text-sm border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded outline-none bg-slate-50 hover:bg-white transition-colors text-slate-800"
                        value={descarga[key] || 0}
                        onChange={(e) => handleDescargaChange(key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* --- DETAILS ROW --- */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
              
              {/* REGIÃO DE ARMAZENAGEM */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden">
                <div className="p-2 sm:p-2.5 bg-slate-700 text-white flex justify-between items-center">
                  <h2 className="text-[10px] sm:text-xs font-bold uppercase tracking-wider">Região de Armazenagem</h2>
                  <span className="text-[8px] sm:text-[9px] font-bold opacity-90 uppercase tracking-widest bg-slate-800 px-1.5 sm:px-2 py-0.5 rounded border border-slate-600 shadow-inner">Total Livre</span>
                </div>
                <div className="flex-grow flex flex-col p-0.5 sm:p-1">
                  {armazenagem.map((item, idx) => (
                    <div key={item.name} className="flex justify-between items-center px-2 sm:px-3 py-0.5 border-b border-slate-100 hover:bg-slate-50 transition-colors bg-white">
                      <span className="uppercase text-[10px] sm:text-[11px] font-bold text-slate-600 tracking-tight">{item.name}</span>
                       <input 
                        type="number"
                        min="0"
                        className="w-12 sm:w-16 h-6 sm:h-7 text-center font-black text-xs border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded outline-none bg-slate-50 hover:bg-white transition-colors text-slate-800"
                        value={item.value || 0}
                        onChange={(e) => updateArrayValue(setArmazenagem, 'armazenagem', idx, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-auto px-3 sm:px-4 py-1.5 sm:py-2 flex justify-between border-t border-slate-200 bg-slate-100 items-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,1)]">
                  <span className="font-black text-[10px] sm:text-xs text-slate-500 uppercase tracking-wider">TOTAL</span>
                  <span className="font-black text-xs sm:text-sm text-slate-800 bg-white px-2 sm:px-3 py-0.5 rounded border border-slate-200 shadow-sm">{totalArmazenagem}</span>
                </div>
              </div>

              {/* PALETES */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">
                <div className="py-2 sm:py-2.5 pr-[10px] sm:pr-[16px] bg-blue-600 text-white flex justify-end items-center relative">
                  <h2 className="absolute left-0 right-0 text-[10px] sm:text-xs font-bold uppercase tracking-wider text-center pointer-events-none">Paletes</h2>
                  <div className="w-16 sm:w-20 flex justify-center">
                    <span className="text-[8px] sm:text-[9px] font-bold opacity-90 uppercase tracking-widest bg-blue-700 px-1.5 sm:px-2 py-0.5 rounded border border-blue-500 shadow-inner">Total</span>
                  </div>
                </div>
                <div className="flex-grow flex flex-col p-0.5 sm:p-1">
                  {paletes.map((item, idx) => (
                    <div key={item.name} className="flex justify-between items-center px-2 sm:px-3 py-1 sm:py-1.5 border-b border-slate-100 hover:bg-slate-50 transition-colors bg-white">
                      <span className="uppercase text-[10px] sm:text-[11px] font-bold text-slate-600">{item.name}</span>
                      <input 
                        type="text"
                        className="w-16 sm:w-20 h-6 sm:h-7 text-center font-black text-xs sm:text-sm border border-slate-200 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 rounded outline-none bg-slate-50 hover:bg-white transition-colors text-slate-800"
                        value={item.value || 0}
                        onChange={(e) => updateArrayValue(setPaletes, 'paletes', idx, e.target.value.replace(/\D/g, ''))}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-auto px-3 sm:px-4 py-2 sm:py-3 flex justify-between border-t border-slate-200 bg-slate-100 items-center shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,1)]">
                  <span className="font-black text-[10px] sm:text-xs text-slate-500 uppercase tracking-wider text-transparent select-none">TOT</span>
                  <span className="font-black text-xs sm:text-sm text-slate-800 bg-white px-2 sm:px-3 py-0.5 rounded border border-slate-200 shadow-sm">{totalPaletes.toLocaleString('pt-BR')}</span>
                </div>
              </div>

              {/* ORGANIZAÇÃO */}
              <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col overflow-hidden h-full">
                <div className="py-2 sm:py-2.5 px-2 sm:px-3 bg-indigo-600 text-white flex justify-end items-center relative">
                  <h2 className="absolute left-0 right-0 text-[10px] sm:text-xs font-bold uppercase tracking-wider text-center pointer-events-none">Organização</h2>
                  <div className="w-[68px] sm:w-[80px] flex justify-center">
                    <span className="text-[8px] sm:text-[9px] font-bold opacity-90 uppercase tracking-widest bg-indigo-700 px-1.5 sm:px-2 py-0.5 rounded border border-indigo-500 shadow-inner">Status</span>
                  </div>
                </div>
                <div className="flex-grow overflow-auto p-0.5 sm:p-1 bg-white">
                  {organizacao.map((item, idx) => (
                    <div key={item.name} className="flex justify-between items-center px-2 sm:px-3 py-0.5 border-b border-slate-100 hover:bg-slate-50 transition-colors">
                      <span className="uppercase text-[10px] sm:text-[11px] font-bold text-slate-600">{item.name}</span>
                      <select
                        className={`w-[68px] sm:w-[80px] text-center text-[9px] sm:text-[10px] font-black px-1 sm:px-2 py-1 rounded cursor-pointer outline-none transition-colors border shadow-sm uppercase tracking-wider focus:ring-2 focus:ring-offset-1 focus:ring-blue-500
                          ${item.value === 'OK' 
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' 
                              : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'}`}
                        value={item.value}
                        onChange={(e) => updateArrayValue(setOrganizacao, 'organizacao', idx, e.target.value)}
                      >
                        <option value="OK" className="bg-white text-slate-800 font-sans">OK</option>
                        <option value="NÃO OK" className="bg-white text-slate-800 font-sans">NÃO OK</option>
                      </select>
                    </div>
                  ))}
                </div>
                {/* Empty bottom bar for visual alignment with the others */}
                <div className="mt-auto h-[34px] sm:h-[45px] border-t border-slate-200 bg-slate-100 shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,1)]"></div>
              </div>

            </div>
          </main>
        </div>

      </div>

      <footer className="w-full text-center py-2 mt-2 shrink-0">
        <p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">(CRIADO POR JEFFERSON AUGUSTO)</p>
      </footer>

      {/* Mobile Install Suggestion Banner */}
      {showInstallBtn && (
        <div className="fixed bottom-0 left-0 right-0 bg-blue-900 border-t border-blue-800 text-white p-3 sm:p-4 shadow-[0_-4px_15px_rgba(0,0,0,0.2)] z-50 flex items-center justify-between sm:hidden animate-in slide-in-from-bottom-full duration-300">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-white rounded-lg p-1 shrink-0 flex items-center justify-center shadow-inner">
               <img src="https://i.postimg.cc/WbTC67S5/lider-3-logo-png-transparent.png" alt="Lider Logo" className="w-full h-full object-contain" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-bold tracking-tight">Instalar App</span>
              <span className="text-[10px] text-blue-200 leading-tight">Adicione à tela inicial para<br/>acesso rápido</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 items-end">
            <button onClick={handleInstallClick} className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-[10px] font-bold uppercase tracking-wider transition-colors shadow-sm whitespace-nowrap">
              Instalar Agora
            </button>
            <button onClick={() => setShowInstallBtn(false)} className="text-blue-300 hover:text-white px-2 py-1 text-[9px] uppercase font-bold tracking-wider">
              Agora não
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
