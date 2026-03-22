import '@testing-library/jest-dom';

// Mock Lucide icons
jest.mock('lucide-react', () => ({
  Activity: () => 'ActivityIcon',
  CheckCircle2: () => 'CheckIcon',
  AlertCircle: () => 'AlertIcon',
  Clock: () => 'ClockIcon',
  TrendingUp: () => 'TrendUpIcon',
  TrendingDown: () => 'TrendDownIcon',
  Search: () => 'SearchIcon',
  RefreshCw: () => 'RefreshIcon',
  ExternalLink: () => 'LinkIcon',
  BarChart3: () => 'ChartIcon',
  ShieldCheck: () => 'ShieldIcon',
  AlertTriangle: () => 'TriangleIcon',
  FileText: () => 'FileIcon',
  History: () => 'HistoryIcon',
  LayoutDashboard: () => 'DashboardIcon',
  Zap: () => 'ZapIcon',
  Download: () => 'DownloadIcon',
  PieChart: () => 'PieIcon',
  LogOut: () => 'LogOutIcon',
  Terminal: () => 'TerminalIcon',
  Play: () => 'PlayIcon',
  XCircle: () => 'XCircleIcon',
  Loader2: () => 'LoaderIcon',
}));

// Mock Recharts
jest.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => children,
  BarChart: ({ children }: any) => children,
  Bar: () => null,
  LineChart: ({ children }: any) => children,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

// Mock Login component
jest.mock('./components/Login', () => ({
  __esModule: true,
  default: () => 'LoginComponent',
}));

// Mock Firebase
jest.mock('firebase/firestore', () => {
  const mockCollection = (_db: any, name: string) => ({ _name: name });
  const mockQuery = (q: any) => q;

  return {
    collection: jest.fn(mockCollection),
    query: jest.fn(mockQuery),
    onSnapshot: jest.fn((q: any, cb: any) => {
      const name = q._name;
      let docs: any[] = [];

      if (name === 'activePositions' || name === 'positions') {
        docs = [
          { 
            id: 'pos1', 
            data: () => ({ 
              symbol: 'RELIANCE.NS', 
              qty: 50, 
              avgEntryPrice: 2400, 
              unrealizedPnl: 1250.50,
              realizedPnl: 0,
              mfeR: 1.2,
              maeR: -0.2,
              status: 'OPEN',
              lastUpdatedAt: { toDate: () => new Date() },
              features: { rsi14: 48, atrPct: 0.025, barsCount: 40 }
            }) 
          }
        ];
      } else if (name === 'statsByRegime') {
        docs = [
          {
            id: 'TrendPullback_TREND',
            data: () => ({ winRate: 0.65, expectancy: 1.42 })
          }
        ];
      } else if (name === 'signals') {
        docs = [
          {
            id: 'sig1',
            data: () => ({ 
              symbol: 'TCS.NS', 
              strategy: 'PullbackEOD', 
              direction: 'BUY', 
              features: { rsi14: 42, atr14: 1.8, barsCount: 40 } 
            })
          }
        ];
      }

      if (typeof cb === 'function') {
        cb({ docs });
      }
      return () => {};
    }),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getFirestore: jest.fn(() => ({})),
    connectFirestoreEmulator: jest.fn(),
  };
});

jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
}));

// Global fetch mock
global.fetch = jest.fn().mockResolvedValue({
  json: () => Promise.resolve({
    groupings: [{ bars: 40, symbols: 100 }]
  })
});
