import { useEffect, useState } from 'react'
import { db } from './firebase'
import { collection, doc, onSnapshot, query, orderBy, limit } from 'firebase/firestore'
import { LayoutDashboard, Activity, Zap, Download, History, PieChart as PieIcon, BarChart3, LogOut, Terminal, Play, CheckCircle2, XCircle, Loader2, Settings } from 'lucide-react'
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import Login from './components/Login'

const GATEWAY_URL = 'https://us-central1-suhas-ag.cloudfunctions.net/gateway';

async function gw(action: string, body: Record<string, unknown> = {}, opts?: { raw?: boolean }) {
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    mode: 'cors',
    body: JSON.stringify({ action, ...body }),
  });
  if (opts?.raw) return res;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status}: ${txt}`);
  }
  return res.json();
}

// Basic types to match backend models
interface Position {
  symbol: string;
  avgEntryPrice?: number;
  entryPrice?: number;
  qty: number;
  unrealizedPnl: number;
  unrealizedPnlPct?: number;
  currentPrice?: number;
  realizedPnl: number;
  status: string;
  direction?: string;
  strategy?: string;
  exitReason?: string;
  lastUpdatedAt: any;
  mfeR?: number;
  maeR?: number;
  mfeAtr?: number;
  targets?: number[];
  stopPrice?: number;
  entryDate?: string;
}

interface Job {
  id: string;
  type: string;
  status: string;
  runDate: string;
  universeId?: string;
  stage: string;
  counts: { total: number; done: number; failed: number };
  startedAt: any;
  updatedAt: any;
  marketState?: string;
  dataSource?: string;
  errorMessage?: string;
}


function App() {
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('protrade_auth'))
  const [view, setView] = useState<'DASHBOARD' | 'HISTORY' | 'LOGS' | 'SETTINGS'>('DASHBOARD')
  const [positions, setPositions] = useState<Position[]>([])
  const [history, setHistory] = useState<Position[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [signals, setSignals] = useState<any[]>([])
  const [watchlist, setWatchlist] = useState<any[]>([])
  const [wlStats, setWlStats] = useState<any>(null)
  const [wlStatsLoading, setWlStatsLoading] = useState(false)
  const [logs, setLogs] = useState<any[]>([])
  const [stats, setStats] = useState({ equity: 1000000, realizedPnl: 0, openPositions: 0, winRate: 0 })
  const [statsByRegime, setStatsByRegime] = useState<any[]>([])
  const [isTriggering, setIsTriggering] = useState(false)
  const [universe, setUniverse] = useState<'nifty50' | 'nifty500' | 'midsmall400' | 'sample'>(
    (localStorage.getItem('protrade_universe') as any) || 'midsmall400'
  )
  const [inventory, setInventory] = useState<any>(null);
  const [isRefreshingInventory, setIsRefreshingInventory] = useState(false);
  const [equitySeries, setEquitySeries] = useState<any[]>([]);
  // Use IST (UTC+5:30) so the dashboard date matches the NSE trading day
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    return ist.toISOString().split('T')[0];
  });
  const [settingsForm, setSettingsForm] = useState({ apiKey: '', apiSecret: '', userId: '', password: '', totpSecret: '' });
  const [settingsStatus, setSettingsStatus] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [telegramForm, setTelegramForm] = useState({ botToken: '', chatId: '', enabled: false });
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);

  // Auto-capture request_token from Kite redirect URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reqToken = params.get('request_token');
    if (reqToken) {
      setFormConfig(prev => ({ ...prev, requestToken: reqToken }));
      // Clean URL without reload
      window.history.replaceState({}, '', window.location.pathname);
      // Auto-link if we have credentials
      const autoLink = async () => {
        try {
          const data = await gw('updateToken', { requestToken: reqToken });
          alert(data.message || 'Kite session linked automatically!');
          setKiteStatus('UPDATING');
          setTimeout(() => window.location.reload(), 1500);
        } catch (err: any) {
          alert(`Auto-link failed. Token captured — click "Link Token" manually.\n${err.message}`);
        }
      };
      autoLink();
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('protrade_universe', universe);
  }, [universe]);

  useEffect(() => {
    if (!authToken) return;
    const fetchInventory = async () => {
      try {
        const data = await gw('probeInventory');
        setInventory(data);
      } catch (err) {
        console.error('Failed to fetch inventory:', err);
      }
    };
    fetchInventory();
    const invInterval = setInterval(fetchInventory, 300000); // 5 mins

    // Fetch watchlist conversion stats
    const fetchWlStats = async () => {
      setWlStatsLoading(true);
      try {
        const res = await fetch(GATEWAY_URL + '?action=watchlistStats&days=30');
        const data = await res.json();
        setWlStats(data);
      } catch (err) { console.error('WL stats fetch failed:', err); }
      setWlStatsLoading(false);
    };
    fetchWlStats();

    return () => clearInterval(invInterval);
  }, [authToken]);

  useEffect(() => {
    if (!authToken) return;

    // 1. Listen for positions (stored under portfolio/default/positions subcollection)
    const posQuery = query(collection(db, 'portfolio', 'default', 'positions'));
    const unsubPos = onSnapshot(posQuery, (snap: any) => {
      const allPos = snap.docs.map((doc: any) => doc.data() as Position);
      const active = allPos.filter((p: Position) => p.status === 'OPEN');
      const closed = allPos.filter((p: Position) => p.status === 'CLOSED').sort((a: Position, b: Position) => (b.lastUpdatedAt?.seconds || 0) - (a.lastUpdatedAt?.seconds || 0));
      
      setPositions(active);
      setHistory(closed);
      console.log(`[Dashboard] Active Positions:`, active.length);
      
      const wins = closed.filter((p: Position) => p.realizedPnl > 0).length;
      const wr = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;

      // realizedPnl is sourced from the account (authoritative trades ledger, incl. partial
      // exits on still-open positions), NOT re-summed from closed positions here.
      setStats((prev: any) => ({ ...prev, openPositions: active.length, winRate: wr }));
    });

    // 4. Listen for aggregate stats (Scoreboard)
    const unsubStats = onSnapshot(collection(db, 'aggregateStats'), (snap) => {
      setStatsByRegime(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    // 5. Listen for jobs (Run History)
    const jobsQuery = query(collection(db, 'jobs'), orderBy('startedAt', 'desc'), limit(10));
    const unsubJobs = onSnapshot(jobsQuery, (snap: any) => {
      const allJobs = snap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }) as Job);
      setJobs(allJobs);
      console.log(`[Dashboard] Jobs loaded:`, allJobs.length);
    });

    // 6. Listen for account equity (source of truth is config/account)
    const unsubAccount = onSnapshot(doc(db, 'config', 'account'), (snap) => {
      const acct = snap.data();
      if (acct?.equity != null) setStats((prev: any) => ({
        ...prev,
        equity: acct.equity,
        ...(acct.realizedPnl != null ? { realizedPnl: acct.realizedPnl } : {}),
      }));
    });

    // 7. Listen for the persisted daily equity time-series (real equity curve,
    //    written every EOD at stats/equityCurve/days/{dateId}).
    const equityQuery = query(collection(db, 'stats', 'equityCurve', 'days'), orderBy('__name__', 'desc'), limit(120));
    const unsubEquity = onSnapshot(equityQuery, (snap: any) => {
      const rows = snap.docs
        .map((d: any) => ({ dateId: d.id, ...(d.data() as any) }))
        .reverse();
      setEquitySeries(rows);
    });

    return () => {
      unsubPos();
      unsubJobs();
      unsubAccount();
      unsubStats();
      unsubEquity();
    };
  }, [authToken])

  useEffect(() => {
    if (!authToken) return;

    const dateId = selectedDate.replace(/-/g, '');
    
    // Listen for signals
    const currentSignalsQuery = query(collection(db, 'signals', dateId, 'items'));
    const unsubSignalsCurrent = onSnapshot(currentSignalsQuery, (snap) => {
        setSignals(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        console.log(`[Dashboard] Signals for ${dateId}:`, snap.size);
    });

    // Listen for watchlist
    const watchlistQuery = query(collection(db, 'watchlist', dateId, 'items'));
    const unsubWatchlist = onSnapshot(watchlistQuery, (snap) => {
        setWatchlist(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        console.log(`[Dashboard] Watchlist for ${dateId}:`, snap.size);
    });

    // Listen for logs
    const logsQuery = query(collection(db, 'logs', dateId, 'entries'), orderBy('timestamp', 'desc'), limit(50));
    const unsubLogs = onSnapshot(logsQuery, (snap: any) => {
      setLogs(snap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
    });

    return () => {
      unsubSignalsCurrent();
      unsubWatchlist();
      unsubLogs();
    };
  }, [authToken, selectedDate])

  useEffect(() => {
    if (!authToken || jobs.length === 0) return;
    
    // Auto-audit check: If any job is running and started > 15 mins ago
    const stuckJobs = jobs.filter(j => 
      j.status === 'RUNNING' && 
      (Date.now() - (j.startedAt?.seconds * 1000 || 0)) > 15 * 60 * 1000
    );

    if (stuckJobs.length > 0) {
      console.log(`[Dashboard] Detected ${stuckJobs.length} potentially stuck jobs. Triggering Audit...`);
      gw('auditJobs').catch(err => console.error('Audit trigger failed:', err));
    }
  }, [jobs, authToken]);

  const handleLogout = () => {
    localStorage.removeItem('protrade_auth');
    setAuthToken(null);
  };

  const handleTriggerScan = async () => {
    setIsTriggering(true);
    console.log(`[Dashboard] Triggering scan for universe: ${universe}`);
    try {
      const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
      
      console.log(`[Dashboard] Triggering EOD for ${universe} on ${today}`);
      const data = await gw('startEod', { date: today, universe });
      console.log(`[Dashboard] Trigger Success:`, data);
      alert(`✅ Scan Triggered Successfully!\nUniverse: ${universe.toUpperCase()}\nJob ID: ${data.jobId}`);
    } catch (err: any) {
      console.error(`[Dashboard] Trigger Failed:`, err);
      alert(`❌ Failed to trigger scan.\nError: ${err.message}\nCheck console for details.`);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleRefreshInventory = async () => {
    setIsRefreshingInventory(true);
    try {
      const data = await gw('probeInventory');
      setInventory(data);
    } catch (err) {
      console.error('Failed to refresh inventory:', err);
    } finally {
      setIsRefreshingInventory(false);
    }
  };

  const [kiteStatus, setKiteStatus] = useState<'LOADING' | 'ACTIVE' | 'EXPIRED' | 'ERROR' | 'UPDATING'>('LOADING')
  const [kiteMeta, setKiteMeta] = useState<any>(null)
  
  // Inline Form State
  const [formConfig, setFormConfig] = useState({
    apiKey: '',
    apiSecret: '',
    userId: '',
    password: '',
    totpSecret: '',
    requestToken: '',
    disableFallback: false
  });

  useEffect(() => {
    if (!authToken) return;
    const unsub = onSnapshot(collection(db, 'settings'), (snap) => {
      const kite = snap.docs.find(d => d.id === 'kite')?.data();
      if (kite) {
        setKiteMeta(kite);
        setFormConfig(prev => ({
          ...prev,
          apiKey: kite.apiKey || '',
          apiSecret: kite.apiSecret || '',
          userId: kite.userId || '',
          password: kite.password || '',
          totpSecret: kite.totpSecret || '',
          disableFallback: !!kite.disableFallback
        }));
      }
      const telegram = snap.docs.find(d => d.id === 'telegram')?.data();
      if (telegram) {
        setTelegramForm(prev => ({
          ...prev,
          chatId: telegram.chatId || '',
          enabled: !!telegram.enabled,
        }));
      }
    });
    return unsub;
  }, [authToken]);

  useEffect(() => {
    if (!authToken) return;
    const checkHealth = async () => {
      try {
        const data = await gw('checkHealth');
        setKiteStatus(data.status);
      } catch (err) {
        setKiteStatus('ERROR');
      }
    };
    checkHealth();
    const interval = setInterval(checkHealth, 300000); // Every 5 mins
    return () => clearInterval(interval);
  }, [authToken]);

  const handleUpdateConfig = async () => {
    try {
      const res = await gw('updateCredentials', {
        apiKey: formConfig.apiKey,
        apiSecret: formConfig.apiSecret,
        userId: formConfig.userId,
        password: formConfig.password,
        totpSecret: formConfig.totpSecret,
        disableFallback: formConfig.disableFallback
      }, { raw: true }) as Response;
      if (res.ok) {
        alert('Configuration saved successfully.');
      } else {
        const txt = await res.text();
        alert(`Failed to save: ${txt}`);
      }
    } catch (err: any) {
      alert(`Network Error: ${err.message}`);
    }
  };


  const handleManualLink = async () => {
    if (!formConfig.requestToken) {
      alert('Please enter a Request Token');
      return;
    }

    try {
      const data = await gw('updateToken', {
        requestToken: formConfig.requestToken,
        apiKey: formConfig.apiKey || kiteMeta?.apiKey,
        apiSecret: formConfig.apiSecret || kiteMeta?.apiSecret
      });
      alert(data.message || 'Kite session updated');
      setKiteStatus('UPDATING');
      setTimeout(() => window.location.reload(), 1500);
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleKiteLogin = () => {
    const apiKey = kiteMeta?.apiKey || 'm0unb8k99qo1ak4m';
    window.location.href = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}`;
  };

  const handleRunPaperTrading = async () => {
    setIsTriggering(true);
    const today = new Date().toISOString().split('T')[0];
    try {
      const res = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
        body: JSON.stringify({ action: 'startEod', date: today, universe, force: true }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(data.message || 'Paper trading simulation started');
      } else {
        alert(`Error: ${data.error || data.message || 'Failed to start simulation'}`);
      }
    } catch (err: any) {
      alert(`Network Error: ${err.message}`);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleStopJob = async (jobId: string) => {
    if (!confirm(`Are you sure you want to stop job ${jobId}?`)) return;
    try {
      const data = await gw('terminate', { jobId });
      alert(data.message || 'Termination requested');
    } catch (err) {
      alert('Failed to stop job');
    }
  };

  const latestRegime = jobs.find(j => j.marketState)?.marketState || 'UNKNOWN';

  const downloadHistory = () => {
    if (history.length === 0) return;
    const headers = ["Symbol", "Qty", "Avg Entry", "Realized PnL", "Exit Reason", "Date"];
    const rows = history.map(p => [
      p.symbol,
      p.qty,
      p.avgEntryPrice,
      p.realizedPnl,
      p.exitReason || "N/A",
      p.lastUpdatedAt?.toDate?.().toISOString() || "N/A"
    ]);
    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trade_history_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  if (!authToken) {
    return <Login onLogin={setAuthToken} />;
  }



  const pnlChartData = history.slice(0, 10).reverse().map(p => ({
    name: p.symbol,
    pnl: p.realizedPnl
  }));

  // Calculate Equity Curve Data
  // Prefer the persisted daily equity snapshots (stats/equityCurve/days) which track
  // real account equity (initial + realized + open MTM) every EOD. Fall back to the
  // closed-trade cumulative PnL only when no snapshots exist yet.
  let equityCurveData: any[];
  if (equitySeries.length > 0) {
    equityCurveData = equitySeries.map((r) => ({
      name: `${r.dateId?.slice(4, 6)}/${r.dateId?.slice(6, 8)}`,
      totalPnL: Math.round(Number(r.equity) || 0),
      symbol: r.dateId,
    }));
  } else {
    const sortedHistory = [...history].sort((a, b) => (a.lastUpdatedAt?.seconds || 0) - (b.lastUpdatedAt?.seconds || 0));
    let runningPnL = 0;
    equityCurveData = sortedHistory.map((p, i) => {
      runningPnL += (p.realizedPnl || 0);
      return { name: i + 1, totalPnL: runningPnL, symbol: p.symbol };
    });
    if (equityCurveData.length > 0) {
      equityCurveData.unshift({ name: 0, totalPnL: 0, symbol: 'START' });
    }
  }

  // Portfolio breakdown — all reconcile by construction: equity = cash + deployed + unrealized.
  const inr = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const capitalDeployed = positions.reduce((a, p) => a + ((p.avgEntryPrice || p.entryPrice || 0) * (p.qty || 0)), 0);
  const unrealizedTotal = positions.reduce((a, p) => a + (p.unrealizedPnl || 0), 0);
  const cashBalance = stats.equity - capitalDeployed - unrealizedTotal;

  return (
    <div className="dashboard-container">
      <header className="header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <LayoutDashboard size={24} color="#10b981" />
          <h1>PROTRADE <span style={{ color: '#444', fontWeight: 400 }}>| ALPHA</span></h1>
        </div>
        
        <nav style={{ display: 'flex', gap: '2rem', marginLeft: '3rem' }}>
          <button 
            onClick={() => setView('DASHBOARD')}
            style={{ 
              background: 'none', border: 'none', color: view === 'DASHBOARD' ? '#10b981' : '#444', 
              fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' 
            }}
          >
            <Activity size={16} /> Overview
          </button>
          <button 
            onClick={() => setView('HISTORY')}
            style={{ 
              background: 'none', border: 'none', color: view === 'HISTORY' ? '#10b981' : '#444', 
              fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' 
            }}
          >
            <History size={16} /> System Runs
          </button>
          <button 
            onClick={() => setView('LOGS')}
            style={{ 
              background: 'none', border: 'none', color: view === 'LOGS' ? '#10b981' : '#444', 
              fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' 
            }}
          >
            <Terminal size={16} /> Logs
          </button>
          <button 
            onClick={() => setView('SETTINGS')}
            style={{ 
              background: 'none', border: 'none', color: view === 'SETTINGS' ? '#10b981' : '#444', 
              fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' 
            }}
          >
            <Settings size={16} /> Settings
          </button>
        </nav>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginLeft: 'auto' }}>
          <input 
            type="date" 
            className="input" 
            style={{ fontSize: '0.8rem', padding: '0.4rem', height: 'auto', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '4px' }}
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
          />
          <button className="btn-premium" onClick={downloadHistory}>
            <Download size={16} /> Download Report
          </button>
          <button 
            onClick={handleLogout}
            style={{ 
              background: 'rgba(239, 68, 68, 0.1)', border: 'none', color: '#ef4444', 
              padding: '0.5rem', borderRadius: '8px', cursor: 'pointer' 
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </header>


        {kiteStatus === 'EXPIRED' && (
          <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <XCircle color="#ef4444" size={24} />
              <div>
                <div style={{ fontWeight: 600, color: '#ef4444' }}>Kite Session Expired</div>
                <div style={{ fontSize: '0.8rem', color: '#fca5a5' }}>
                  Your Kite session has expired. Historical data might use a fallback source. Please re-link your session to ensure real-time data and execution.
                </div>
              </div>
            </div>
            <button onClick={handleKiteLogin} className="btn-premium" style={{ background: '#ef4444' }}>Fix Session</button>
          </div>
        )}

        {view === 'DASHBOARD' && (
          <>
          <section className="stats-grid" style={{ gridArea: 'stats' }}>
            <div className="card">
              <div className="stat-label">Total Equity</div>
              {/* config/account.equity = initial + realized + open MTM; never re-add unrealizedPnl */}
              <div className="stat-value">{inr(stats.equity)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Cash Balance</div>
              <div className="stat-value">{inr(cashBalance)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Capital Deployed</div>
              <div className="stat-value">{inr(capitalDeployed)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Unrealized PnL</div>
              <div className={`stat-value ${unrealizedTotal >= 0 ? 'up' : 'down'}`}>{unrealizedTotal >= 0 ? '+' : ''}{inr(unrealizedTotal)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Realized PnL</div>
              <div className={`stat-value ${stats.realizedPnl >= 0 ? 'up' : 'down'}`}>{stats.realizedPnl >= 0 ? '+' : ''}{inr(stats.realizedPnl)}</div>
            </div>
            <div className="card">
              <div className="stat-label">Active Trades</div>
              <div className="stat-value">{stats.openPositions}</div>
            </div>
            <div className="card">
              <div className="stat-label">Win Rate</div>
              <div className="stat-value" style={{ color: '#fbbf24' }}>{stats.winRate}%</div>
            </div>
          </section>

          <section className="card" style={{ marginBottom: '1.5rem', borderLeft: '4px solid #3b82f6' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <BarChart3 size={18} color="#3b82f6" /> System Data Inventory
              </h3>
              <button 
                onClick={handleRefreshInventory} 
                className="btn-premium" 
                style={{ fontSize: '0.7rem', padding: '4px 10px' }}
                disabled={isRefreshingInventory}
              >
                {isRefreshingInventory ? <Loader2 className="animate-spin" size={14} /> : 'Refresh Data'}
              </button>
            </div>

            {!inventory ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>
                <Loader2 className="animate-spin" size={24} style={{ margin: '0 auto 1rem' }} />
                Loading detailed system inventory...
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                <div>
                  <h4 style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>Data Coverage (Bars Available)</h4>
                  <div style={{ height: '180px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={inventory.groupings}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                        <XAxis dataKey="bars" stroke="#64748b" fontSize={10} label={{ value: 'Days', position: 'insideBottom', offset: -5, fill: '#64748b', fontSize: 10 }} />
                        <YAxis stroke="#64748b" fontSize={10} />
                        <Tooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px' }} />
                        <Bar dataKey="symbols" fill="#3b82f6" radius={[4, 4, 0, 0]} label={{ position: 'top', fill: '#94a3b8', fontSize: 10 }} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div>
                  <h4 style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '1rem' }}>Signal Strategy Distribution</h4>
                  <div style={{ height: '180px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={inventory.signalStats?.byStrategy || []}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                        <XAxis dataKey="name" stroke="#64748b" fontSize={10} />
                        <YAxis stroke="#64748b" fontSize={10} />
                        <Tooltip contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px' }} />
                        <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} label={{ position: 'top', fill: '#94a3b8', fontSize: 10 }} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div style={{ gridColumn: 'span 2', display: 'flex', gap: '2rem', background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '8px', marginTop: '0.5rem' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Symbols Tracked</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{inventory.totalSymbolsTracked}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.7rem', color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Sufficient Data (≥60 bars)</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#10b981' }}>{inventory.symbolsWithSufficientData ?? '—'}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.7rem', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Insufficient (&lt;60 bars)</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#ef4444' }}>{inventory.symbolsInsufficient ?? '—'}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Universe Coverage</div>
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
                      {inventory.universes?.map((u: any) => (
                        <div key={u.id} className="trend-badge range" style={{ fontSize: '0.65rem' }}>
                          {u.id.toUpperCase()}: {u.count}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.7rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Inventory Refreshed</div>
                    <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{new Date(inventory.timestamp).toLocaleTimeString()}</div>
                  </div>
                </div>

                {/* Data coverage summary table */}
                {inventory.groupings?.length > 0 && (
                  <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #334155' }}>
                          <th style={{ textAlign: 'left', padding: '6px 8px', color: '#94a3b8', fontWeight: 600 }}>Date Range</th>
                          <th style={{ textAlign: 'right', padding: '6px 8px', color: '#94a3b8', fontWeight: 600 }}>Symbols</th>
                          <th style={{ textAlign: 'right', padding: '6px 8px', color: '#94a3b8', fontWeight: 600 }}>Signals Found</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventory.groupings.map((g: any, i: number) => (
                          <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                            <td style={{ padding: '6px 8px', color: '#e2e8f0' }}>{g.bars} days</td>
                            <td style={{ padding: '6px 8px', color: '#e2e8f0', textAlign: 'right' }}>{g.symbols} symbols</td>
                            <td style={{ padding: '6px 8px', color: '#10b981', textAlign: 'right' }}>{inventory.signalStats?.total ?? 0} signals</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>

          <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem', gridArea: 'controls' }}>
            <div className="card" style={{ borderLeft: '4px solid #10b981' }}>
              <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={18} color="#10b981" /> System Risk & Regime
              </h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>Current Regime</div>
                  <div className={`trend-badge ${latestRegime === 'TREND' ? 'up' : latestRegime === 'BEAR' ? 'down' : 'range'}`} style={{ fontSize: '1.2rem', padding: '0.5rem 1rem' }}>
                    {latestRegime}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flex: 1, marginLeft: '2rem' }}>
                  <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>Risk Multiplier: <span style={{ color: '#10b981' }}>1.0x</span></div>
                  <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: '0.5rem', fontStyle: 'italic' }}>
                    "Index in confirmed uptrend. Bullish bias active."
                  </div>
                  <button 
                    onClick={handleRunPaperTrading}
                    disabled={isTriggering}
                    className="btn-premium"
                    style={{ 
                      marginTop: '1rem', 
                      width: 'fit-content', 
                      alignSelf: 'flex-end',
                      fontSize: '0.75rem', 
                      padding: '0.4rem 1rem' 
                    }}
                  >
                    {isTriggering ? <Loader2 className="spin" size={14} /> : <Play size={14} />} 
                    <span style={{ marginLeft: '0.5rem' }}>Run Paper Trading Simulation</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="card" style={{ borderLeft: '4px solid #fbbf24' }}>
              <h3 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <PieIcon size={18} color="#fbbf24" /> Strategy Scoreboard (Regime-Adjusted)
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                {statsByRegime.length === 0 ? (
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>Awaiting edge validation...</div>
                ) : (
                  statsByRegime.slice(0, 4).map(s => (
                    <div key={s.id} style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
                      <div style={{ fontSize: '0.7rem', color: '#94a3b8', fontWeight: 600 }}>{s.id.split('_')[0]} ({s.id.split('_')[1]})</div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.8rem', color: '#10b981' }}>{Math.round(s.winRate*100)}% WR</span>
                        <span style={{ fontSize: '0.8rem', color: '#fbbf24' }}>{s.expectancy.toFixed(2)}E</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>

          <section className="card" style={{ borderLeft: kiteStatus === 'ACTIVE' ? '4px solid #10b981' : '4px solid #ef4444', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Terminal size={18} color="#3b82f6" /> Kite Integration Hub
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: kiteStatus === 'ACTIVE' ? '#10b981' : kiteStatus === 'LOADING' ? '#fbbf24' : '#ef4444' }}></div>
                <span style={{ color: '#94a3b8' }}>{kiteStatus}</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
              {/* Left: Constant API Config */}
              <div style={{ borderRight: '1px solid rgba(255,255,255,0.05)', paddingRight: '2rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '1rem', color: '#3b82f6' }}>1. API Credentials (Persistent)</div>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <input className="input" placeholder="API Key" style={{ fontSize: '0.7rem' }} value={formConfig.apiKey} onChange={e => setFormConfig({...formConfig, apiKey: e.target.value})} />
                  <input className="input" placeholder="API Secret" type="password" style={{ fontSize: '0.7rem' }} value={formConfig.apiSecret} onChange={e => setFormConfig({...formConfig, apiSecret: e.target.value})} />
                  <button onClick={handleUpdateConfig} className="btn-premium" style={{ width: '100%', fontSize: '0.7rem' }}>Save App Credentials</button>
                </div>
              </div>

              {/* Right: Temporary Session / Token */}
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '1rem', color: '#fbbf24' }}>2. Active Session Management</div>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <button 
                    onClick={() => { window.location.href = `https://kite.zerodha.com/connect/login?v=3&api_key=${formConfig.apiKey || kiteMeta?.apiKey || 'm0unb8k99qo1ak4m'}`; }}
                    className="btn-premium" style={{ width: '100%', fontSize: '0.7rem', background: '#fbbf24', color: '#000' }}
                  >
                    Open Kite Login Page
                  </button>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <input 
                      className="input" placeholder="Paste Request Token" style={{ fontSize: '0.7rem', flex: 1 }}
                      value={formConfig.requestToken} onChange={e => setFormConfig({...formConfig, requestToken: e.target.value})}
                    />
                    <button onClick={handleManualLink} className="btn-premium" style={{ fontSize: '0.7rem' }}>Link Token</button>
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#64748b' }}>
                    * Log in to Kite, then copy the <code>request_token</code> from the URL after redirect.
                  </div>
                </div>
              </div>
            </div>
          </section>

          <div className="positions-area">
            <section className="card" style={{ height: '100%' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <Activity size={18} /> Active Positions (Monitoring)
              </h3>
              {positions.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: '#444' }}>No active positions.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Dir × Qty</th>
                      <th>Entry</th>
                      <th>Current</th>
                      <th>PnL</th>
                      <th>MFE (ATR)</th>
                      <th>Strategy</th>
                      <th>Stop</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(p => {
                      const entry = p.entryPrice || p.avgEntryPrice || 0;
                      const pnl = p.unrealizedPnl || 0;
                      const target = p.targets?.[0] || p.stopPrice || 0;
                      const progress = target > entry ? 
                        Math.max(0, Math.min(100, ((entry + (pnl/(p.qty||1))) - entry) / (target - entry) * 100)) : 0;
                      
                      return (
                        <tr key={p.symbol}>
                          <td><span className="symbol-tag">{p.symbol}</span></td>
                          <td>{p.direction || 'BUY'} × {p.qty}</td>
                          <td>₹{entry.toFixed(2)}</td>
                          <td>{p.currentPrice != null ? `₹${p.currentPrice.toFixed(2)}` : '—'}</td>
                          <td className={pnl >= 0 ? 'up-text' : 'down-text'}>
                            ₹{pnl.toFixed(2)}{p.unrealizedPnlPct != null ? ` (${(p.unrealizedPnlPct * 100).toFixed(2)}%)` : ''}
                          </td>
                          <td style={{ fontSize: '0.75rem', color: '#10b981' }}>
                            {p.mfeAtr != null ? `${p.mfeAtr.toFixed(1)}×ATR` : '—'}
                          </td>
                          <td style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                            {p.strategy || 'N/A'}
                          </td>
                          <td style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                            ₹{p.stopPrice?.toFixed(2) || 'N/A'}
                          </td>
                          <td style={{ width: '100px' }}>
                            <div style={{ fontSize: '0.65rem', color: '#94a3b8', marginBottom: '2px' }}>{p.entryDate || ''}</div>
                            <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px' }}>
                              <div style={{ width: `${progress}%`, height: '100%', background: '#10b981', borderRadius: '2px' }}></div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <div className="signals-area">
            <section className="card" style={{ height: '100%', marginBottom: '1.5rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <Activity size={18} /> VCP Pivot Watchlist
              </h3>
              {watchlist.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#444', fontSize: '0.8rem' }}>No symbols nearing pivot for today.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '460px', overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {[...watchlist].sort((a, b) => {
                    // Rank: TRIGGERED first, then closest-below-pivot (READY/SETUP), then EXTENDED/INVALIDATED.
                    const rank = (s: string) => ({ TRIGGERED: 0, READY: 1, SETUP: 2, EXTENDED: 3, INVALIDATED: 4 } as any)[s] ?? 5;
                    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
                    return Math.abs(a.distToPivotPct ?? 1) - Math.abs(b.distToPivotPct ?? 1);
                  }).map(w => {
                    const dist = w.distToPivotPct != null ? w.distToPivotPct * 100 : null;
                    const badgeClass = w.status === 'TRIGGERED' || w.status === 'READY' ? 'up'
                      : w.status === 'INVALIDATED' ? 'down' : 'range';
                    return (
                    <div key={w.id} className="signal-item" style={{ background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{w.symbol}</div>
                          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                            {w.strategy} • RS rank: {w.features?.rsRank126 ?? 'N/A'} •
                            VCP: {(w.features?.vcpRange40 * 100).toFixed(0)}%→{(w.features?.vcpRange20 * 100).toFixed(0)}%→{(w.features?.vcpRange10 * 100).toFixed(0)}%
                          </div>
                        </div>
                        <div className={`trend-badge ${badgeClass}`}>
                          {w.status === 'READY' ? 'NEAR PIVOT' : w.status}
                        </div>
                      </div>
                      <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#94a3b8', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.5rem' }}>
                        {w.pivot != null ? (
                          <>Pivot ₹{w.pivot.toFixed(2)} • {dist != null ? (dist >= 0 ? `${dist.toFixed(1)}% above` : `${Math.abs(dist).toFixed(1)}% below`) : '—'} • Close ₹{w.close.toFixed(2)}</>
                        ) : (
                          <>Pivot forming • Close ₹{w.close.toFixed(2)}</>
                        )}
                        <br />
                        {w.structuralLow != null && <>Stop ref ₹{w.structuralLow.toFixed(2)} • </>}
                        Vol-dryup {w.features?.volDryUpRatio != null ? `${w.features.volDryUpRatio.toFixed(2)}x` : '—'} • ATR↓ {w.features?.atrCompressing ? '✅' : '❌'} • VDU {w.features?.vduActive ? '✅' : '❌'}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="card" style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <PieIcon size={18} /> Watchlist Conversion Analytics (30d)
              </h3>
              {wlStatsLoading ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b' }}><Loader2 size={16} className="spin" /> Loading...</div>
              ) : !wlStats?.summary ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#444', fontSize: '0.8rem' }}>No historical watchlist data yet.</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ background: 'rgba(16,185,129,0.1)', padding: '0.75rem', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#10b981' }}>{wlStats.summary.breakouts}</div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Breakouts</div>
                    </div>
                    <div style={{ background: 'rgba(239,68,68,0.1)', padding: '0.75rem', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#ef4444' }}>{wlStats.summary.invalidated}</div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Invalidated</div>
                    </div>
                    <div style={{ background: 'rgba(59,130,246,0.1)', padding: '0.75rem', borderRadius: '8px', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#3b82f6' }}>{wlStats.summary.conversionRate}</div>
                      <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Conversion Rate</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem', marginBottom: '1rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                    <div>Tracked: <strong>{wlStats.summary.totalTracked}</strong></div>
                    <div>Ready: <strong>{wlStats.summary.stillReady}</strong></div>
                    <div>Setup: <strong>{wlStats.summary.stillSetup}</strong></div>
                    <div>Extended: <strong>{wlStats.summary.extended}</strong></div>
                  </div>
                  {wlStats.items && wlStats.items.length > 0 && (
                    <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem' }}>
                        <thead><tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)', color: '#64748b' }}>
                          <th style={{ textAlign: 'left', padding: '0.4rem' }}>Symbol</th>
                          <th>Days</th>
                          <th>First</th>
                          <th>Current</th>
                          <th>Outcome</th>
                        </tr></thead>
                        <tbody>
                          {[...wlStats.items].sort((a: any, b: any) => {
                            const rank = (o: string) => ({ BREAKOUT: 0, READY: 1, SETUP: 2, EXTENDED: 3, TRIGGERED: 0, INVALIDATED: 4 } as any)[o] ?? 5;
                            return rank(a.outcome) - rank(b.outcome);
                          }).map((item: any) => (
                            <tr key={item.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <td style={{ padding: '0.4rem', fontWeight: 600 }}>{item.symbol}</td>
                              <td style={{ textAlign: 'center' }}>{item.datesSeen}</td>
                              <td style={{ textAlign: 'center' }}>{item.firstStatus}</td>
                              <td style={{ textAlign: 'center' }}>{item.lastStatus}</td>
                              <td style={{ textAlign: 'center' }}>
                                <span className={`trend-badge ${item.outcome === 'BREAKOUT' ? 'up' : item.outcome === 'INVALIDATED' ? 'down' : 'range'}`} style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}>
                                  {item.outcome}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="card" style={{ height: '100%' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                <Zap size={18} /> Signal Lifecycle Monitor
              </h3>
              {signals.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#444', fontSize: '0.8rem' }}>No active signals for today.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '800px', overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {signals.map(s => (
                    <div key={s.id} className="signal-item" style={{ background: 'rgba(255,255,255,0.02)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>{s.symbol}</div>
                          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                            {s.strategy} • Score: {s.score} • 
                            RSI: {s.features?.rsi14?.toFixed(1) || s.features?.rsi?.toFixed(1) || 'N/A'} • 
                            Vol: {s.features?.atrPct ? (s.features.atrPct * 100).toFixed(1) + '%' : 'N/A'}
                          </div>
                        </div>
                        <div className={`trend-badge ${
                          s.status === 'APPROVED' ? 'up' : 
                          s.status === 'ORDERED' ? 'range' : 
                          s.status === 'IN_TRADE' ? 'up' : 
                          'range'
                        }`}>
                          {s.status}
                        </div>
                      </div>
                      {s.riskApproval && (
                        <div style={{ marginTop: '0.5rem', fontSize: '0.7rem', color: '#94a3b8', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '0.5rem' }}>
                          Risk: {s.riskApproval.sizedQty} shares @ ₹{s.riskApproval.riskAmount?.toFixed(0)} risk
                          {s.riskApproval.reason && <div style={{ fontStyle: 'italic', color: '#64748b' }}>{s.riskApproval.reason}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="charts-area">
            <section className="card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                <Activity size={18} /> Equity Curve
              </h3>
              <div style={{ height: '200px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={equityCurveData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} />
                    <Tooltip 
                      contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px' }}
                      labelStyle={{ color: '#94a3b8' }}
                      formatter={(value: any) => [`₹${Number(value).toLocaleString()}`, equitySeries.length > 0 ? 'Equity' : 'Cumulative PnL']}
                    />
                    <Line type="monotone" dataKey="totalPnL" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981', r: 3 }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>



            <section className="card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
                <BarChart3 size={18} /> PnL Distribution
              </h3>
              <div style={{ height: '200px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pnlChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                    <XAxis dataKey="name" stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} />
                    <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ background: '#1e293b', border: 'none', borderRadius: '8px' }} />
                    <Bar dataKey="pnl" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          <section className="card history-area">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <History size={18} /> Trade History
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#444' }}>Showing last {history.length} completed trades</span>
            </div>
            {history.length === 0 ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: '#444' }}>No historical trades found.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Symbol</th><th>Qty</th><th>Avg Entry</th><th>Realized PnL</th><th>Exit Reason</th><th>Date</th></tr>
                </thead>
                <tbody>
                  {history.map((p, i) => (
                    <tr key={i}>
                      <td><span className="symbol-tag" style={{ background: 'rgba(255,255,255,0.05)', color: '#fff' }}>{p.symbol}</span></td>
                      <td>{p.qty}</td>
                      <td>₹{(p.entryPrice || p.avgEntryPrice || 0).toFixed(2)}</td>
                      <td className={(p.realizedPnl||0) >= 0 ? 'up-text' : 'down-text'}>{(p.realizedPnl||0) >= 0 ? '+' : ''}₹{(p.realizedPnl||0).toFixed(2)}</td>
                      <td><div className="trend-badge range" style={{ fontSize: '0.65rem' }}>{p.exitReason}</div></td>
                      <td style={{ color: '#444', fontSize: '0.75rem' }}>{p.lastUpdatedAt?.toDate?.().toLocaleDateString() || 'N/A'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

        {view === 'HISTORY' && (
          <section className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Terminal size={18} /> System Run History
            </h3>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <div style={{ display: 'flex', background: '#1e293b', borderRadius: '8px', padding: '2px' }}>
              <button 
                onClick={() => setUniverse('nifty50')}
                style={{ 
                  padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', fontSize: '0.8rem', cursor: 'pointer',
                  background: universe === 'nifty50' ? '#10b981' : 'transparent',
                  color: universe === 'nifty50' ? '#fff' : '#64748b'
                }}
              >
                Nifty 50
              </button>
              <button 
                onClick={() => setUniverse('nifty500')}
                style={{ 
                  padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', fontSize: '0.8rem', cursor: 'pointer',
                  background: universe === 'nifty500' ? '#10b981' : 'transparent',
                  color: universe === 'nifty500' ? '#fff' : '#64748b'
                }}
              >
                Nifty 500
              </button>
              <button 
                onClick={() => setUniverse('midsmall400')}
                style={{ 
                  padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', fontSize: '0.8rem', cursor: 'pointer',
                  background: universe === 'midsmall400' ? '#10b981' : 'transparent',
                  color: universe === 'midsmall400' ? '#fff' : '#64748b'
                }}
              >
                MidSmall 400
              </button>
              <button 
                onClick={() => setUniverse('sample')}
                style={{ 
                  padding: '0.4rem 1rem', borderRadius: '6px', border: 'none', fontSize: '0.8rem', cursor: 'pointer',
                  background: universe === 'sample' ? '#10b981' : 'transparent',
                  color: universe === 'sample' ? '#fff' : '#64748b'
                }}
              >
                Sample
              </button>
            </div>
            <button 
              className="btn-premium" 
              onClick={handleTriggerScan}
              disabled={isTriggering}
              style={{ background: isTriggering ? '#334155' : '#10b981', cursor: isTriggering ? 'not-allowed' : 'pointer' }}
            >
              {isTriggering ? <Loader2 className="animate-spin" size={16} /> : <Play size={16} />} 
              {isTriggering ? 'Triggering...' : 'Trigger Scan'}
            </button>
          </div>
          </div>

          <table className="table">
            <thead>
              <tr><th>Job ID</th><th>Universe</th><th>Regime</th><th>Source</th><th>Type</th><th>Status</th><th>Stage</th><th>Progress</th><th>Started At</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {jobs.map(job => (
                <tr key={job.id}>
                  <td><code style={{ fontSize: '0.75rem', background: '#1e293b', padding: '2px 6px', borderRadius: '4px' }}>{job.id}</code></td>
                  <td><span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{job.universeId || 'default'}</span></td>
                  <td>
                    {job.marketState ? (
                      <div className={`trend-badge ${job.marketState === 'TREND' ? 'up' : job.marketState === 'BEAR' ? 'down' : 'range'}`}>
                        {job.marketState}
                      </div>
                    ) : <span style={{ color: '#444' }}>-</span>}
                  </td>
                  <td>
                    <span className={`trend-badge ${job.dataSource === 'KITE' ? 'up' : 'range'}`} style={{ fontSize: '0.65rem' }}>
                      {job.dataSource || 'YAHOO'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600, color: '#334155' }}>
                    {job.type === 'EOD_RUN' ? 'EOD Scan' : 'Execution'}
                  </td>
                  <td>
                    {job.status === 'RUNNING' ? (
                      <div style={{ color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                        <Loader2 className="animate-spin" size={14} /> In Progress
                      </div>
                    ) : job.status === 'SUCCESS' || job.status === 'DONE' ? (
                      <div style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                        <CheckCircle2 size={14} /> Completed
                      </div>
                    ) : (
                      <details style={{ cursor: 'pointer' }}>
                        <summary style={{ listStyle: 'none' }}>
                          <div style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem' }}>
                            <XCircle size={14} /> Failed
                          </div>
                        </summary>
                        <div style={{ position: 'absolute', background: '#000', padding: '0.5rem', borderRadius: '4px', fontSize: '0.7rem', border: '1px solid #ef4444', zIndex: 10 }}>
                          {job.errorMessage || 'Unknown failure'}
                        </div>
                      </details>
                    )}
                  </td>
                  <td><span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{job.stage}</span></td>
                  <td>
                    {(() => {
                      const done = job.counts?.done || 0;
                      const failed = job.counts?.failed || 0;
                      const total = job.counts?.total || 0;
                      
                      // Stage-aware progress: show meaningful % even during early stages
                      let pct = 0;
                      if (total > 0) {
                        pct = Math.min(100, ((done + failed) / total) * 100);
                      } else if (job.stage === 'FETCH') {
                        pct = 5; // Started but haven't counted symbols yet
                      } else if (job.stage === 'REGIME') {
                        pct = 10; // Index fetched, computing regime
                      } else if (job.stage === 'SIGNALS') {
                        pct = 15; // Dispatching tasks
                      } else if (job.stage === 'DONE' || job.status === 'DONE') {
                        pct = 100;
                      }

                      const color = job.status === 'DONE' ? '#10b981' : 
                                    job.status === 'FAILED' ? '#ef4444' : 
                                    failed > 0 ? '#f59e0b' : '#3b82f6';

                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ width: '120px', height: '6px', background: '#1e293b', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ 
                              width: `${pct}%`, 
                              height: '100%', 
                              background: color,
                              borderRadius: '3px',
                              transition: 'width 0.5s ease'
                            }} />
                          </div>
                          <span style={{ fontSize: '0.7rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                            {total > 0 ? `${done}/${total}` : job.stage}
                            {failed > 0 && <span style={{ color: '#ef4444', marginLeft: '4px' }}>({failed}✗)</span>}
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ color: '#444', fontSize: '0.75rem' }}>{job.startedAt?.toDate?.().toLocaleString() || 'N/A'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {job.status === 'RUNNING' && (
                        <button 
                          onClick={() => handleStopJob(job.id)}
                          style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                          title="Stop Job"
                        >
                          <XCircle size={16} />
                        </button>
                      )}
                      {(job.status === 'DONE' || job.status === 'SUCCESS') && (
                        <button 
                          onClick={() => window.open(`${GATEWAY_URL}?action=downloadReport&jobId=${job.id}`, '_blank')}
                          style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', padding: '4px' }}
                          title="Download Report"
                        >
                          <Download size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
        {view === 'LOGS' && (
          <div className="card" style={{ background: '#0f172a' }}>
            <h3 style={{ color: '#94a3b8', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Terminal size={18} /> Runtime Activity Logs (Today)
            </h3>
            <div style={{ maxHeight: '600px', overflowY: 'auto', border: '1px solid #1e293b', borderRadius: '8px' }}>
              <table className="table" style={{ border: 'none' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#1e293b', zIndex: 1 }}>
                  <tr><th>Level</th><th>Context</th><th>Message</th><th>Metadata</th><th>Time</th></tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#475569' }}>No logs for today yet.</td></tr>
                  ) : logs.map((log: any) => (
                    <tr key={log.id}>
                      <td>
                        <span style={{ 
                          fontSize: '0.65rem', padding: '2px 6px', borderRadius: '4px', fontWeight: 'bold',
                          color: log.level === 'ERROR' ? '#ef4444' : log.level === 'WARN' ? '#fbbf24' : '#10b981',
                          background: log.level === 'ERROR' ? '#450a0a' : log.level === 'WARN' ? '#451a03' : '#064e3b'
                        }}>
                          {log.level}
                        </span>
                      </td>
                      <td><span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>{log.context || 'SYSTEM'}</span></td>
                      <td style={{ fontSize: '0.85rem' }}>{log.message}</td>
                      <td>
                        {log.metadata && (
                          <details style={{ fontSize: '0.7rem', color: '#64748b' }}>
                            <summary style={{ cursor: 'pointer' }}>View Meta</summary>
                            <pre style={{ marginTop: '0.5rem', background: '#000', padding: '0.5rem', borderRadius: '4px', maxWidth: '300px', overflowX: 'auto' }}>
                              {JSON.stringify(log.metadata, null, 2)}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td style={{ fontSize: '0.75rem', color: '#475569' }}>
                        {log.timestamp?.toDate ? log.timestamp.toDate().toLocaleTimeString() : 'N/A'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {view === 'SETTINGS' && (
          <div style={{ maxWidth: '640px' }}>
            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ color: '#94a3b8', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Settings size={18} /> Kite Connect Credentials
              </h3>
              <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '1rem' }}>
                Required for automated daily Kite session renewal via TOTP. Credentials are stored encrypted in Firestore.
              </p>
              {(['apiKey', 'apiSecret', 'userId', 'password', 'totpSecret'] as const).map(field => (
                <div key={field} style={{ marginBottom: '0.75rem' }}>
                  <label style={{ display: 'block', color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem', textTransform: 'capitalize' }}>
                    {field === 'totpSecret' ? 'TOTP Secret' : field === 'apiKey' ? 'API Key' : field === 'apiSecret' ? 'API Secret' : field === 'userId' ? 'User ID' : 'Password'}
                  </label>
                  <input
                    type={field === 'password' || field === 'apiSecret' || field === 'totpSecret' ? 'password' : 'text'}
                    className="input"
                    style={{ width: '100%', fontSize: '0.85rem', padding: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '4px' }}
                    placeholder={field === 'totpSecret' ? 'Base32 TOTP secret from Kite' : `Enter ${field}`}
                    value={(settingsForm as any)[field]}
                    onChange={e => setSettingsForm(prev => ({ ...prev, [field]: e.target.value }))}
                  />
                </div>
              ))}
              <button
                className="btn-premium"
                disabled={settingsSaving}
                style={{ marginTop: '0.5rem' }}
                onClick={async () => {
                  setSettingsSaving(true);
                  setSettingsStatus(null);
                  try {
                    const payload: any = {};
                    for (const [k, v] of Object.entries(settingsForm)) { if (v) payload[k] = v; }
                    await gw('updateCredentials', payload);
                    setSettingsStatus('✅ Credentials saved successfully');
                    setSettingsForm({ apiKey: '', apiSecret: '', userId: '', password: '', totpSecret: '' });
                  } catch (err: any) {
                    setSettingsStatus(`❌ ${err.message}`);
                  } finally {
                    setSettingsSaving(false);
                  }
                }}
              >
                {settingsSaving ? <Loader2 size={14} className="spin" /> : null}
                Save Credentials
              </button>
              {settingsStatus && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: settingsStatus.startsWith('✅') ? '#10b981' : '#ef4444' }}>{settingsStatus}</p>}
            </div>

            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ color: '#94a3b8', marginBottom: '1rem' }}>🔄 Test Auto-Renewal</h3>
              <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '1rem' }}>
                Trigger a manual Kite session refresh using saved TOTP credentials.
              </p>
              <button
                className="btn-premium"
                onClick={async () => {
                  setSettingsStatus(null);
                  try {
                    const res = await gw('scheduledKiteRenew');
                    setSettingsStatus(`✅ ${(res as any)?.message || 'Kite session renewed'}`);
                  } catch (err: any) {
                    setSettingsStatus(`❌ Auto-renew failed: ${err.message}`);
                  }
                }}
              >
                🔑 Renew Kite Session Now
              </button>
            </div>

            <div className="card" style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ color: '#94a3b8', marginBottom: '1rem' }}>📲 Telegram Daily Digest</h3>
              <p style={{ color: '#64748b', fontSize: '0.8rem', marginBottom: '1rem' }}>
                Sends the daily EOD snapshot (active trades, day's activity, total P&amp;L) to your Telegram chat. The bot token is stored in Firestore and never displayed back.
              </p>
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Bot Token</label>
                <input
                  type="password"
                  className="input"
                  style={{ width: '100%', fontSize: '0.85rem', padding: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '4px' }}
                  placeholder="Paste bot token from @BotFather"
                  value={telegramForm.botToken}
                  onChange={e => setTelegramForm(prev => ({ ...prev, botToken: e.target.value }))}
                />
              </div>
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ display: 'block', color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.25rem' }}>Chat ID</label>
                <input
                  type="text"
                  className="input"
                  style={{ width: '100%', fontSize: '0.85rem', padding: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '4px' }}
                  placeholder="Your numeric chat ID (from @userinfobot)"
                  value={telegramForm.chatId}
                  onChange={e => setTelegramForm(prev => ({ ...prev, chatId: e.target.value }))}
                />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#94a3b8', fontSize: '0.8rem', margin: '0.5rem 0 1rem' }}>
                <input type="checkbox" checked={telegramForm.enabled} onChange={e => setTelegramForm(prev => ({ ...prev, enabled: e.target.checked }))} />
                Enable daily digest
              </label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn-premium"
                  onClick={async () => {
                    setTelegramStatus(null);
                    try {
                      const payload: any = { enabled: telegramForm.enabled };
                      if (telegramForm.botToken) payload.botToken = telegramForm.botToken;
                      if (telegramForm.chatId) payload.chatId = telegramForm.chatId;
                      await gw('updateTelegram', payload);
                      setTelegramStatus('✅ Telegram settings saved');
                      setTelegramForm(prev => ({ ...prev, botToken: '' }));
                    } catch (err: any) {
                      setTelegramStatus(`❌ ${err.message}`);
                    }
                  }}
                >
                  Save Telegram
                </button>
                <button
                  className="btn-premium"
                  style={{ background: 'rgba(255,255,255,0.08)' }}
                  onClick={async () => {
                    setTelegramStatus(null);
                    try {
                      const res = await gw('testTelegram');
                      setTelegramStatus(`✅ ${(res as any)?.message || 'Test sent'}`);
                    } catch (err: any) {
                      setTelegramStatus(`❌ ${err.message}`);
                    }
                  }}
                >
                  Send Test
                </button>
              </div>
              {telegramStatus && <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: telegramStatus.startsWith('✅') ? '#10b981' : '#ef4444' }}>{telegramStatus}</p>}
            </div>

            <div className="card">
              <h3 style={{ color: '#94a3b8', marginBottom: '1rem' }}>⏰ Daily Automation Schedule</h3>
              <div style={{ color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', padding: '0.5rem 0' }}>
                  <span>🔑 Kite Auto-Renew</span>
                  <span style={{ color: '#10b981' }}>8:30 AM IST (Mon-Fri)</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', padding: '0.5rem 0' }}>
                  <span>📊 EOD Signal Run</span>
                  <span style={{ color: '#10b981' }}>4:30 PM IST (Mon-Fri)</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0' }}>
                  <span>📈 Order Fill Simulation</span>
                  <span style={{ color: '#10b981' }}>Next day EOD run</span>
                </div>
              </div>
              <p style={{ color: '#475569', fontSize: '0.75rem', marginTop: '1rem' }}>
                Requires 2 Cloud Scheduler jobs in GCP Console pointing at the gateway. See documentation for setup.
              </p>
            </div>
          </div>
        )}

    </div>
  )
}

export default App
