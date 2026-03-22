import { render, screen, waitFor } from '@testing-library/react';
import App from './App';

// Mock the internal firebase.ts
jest.mock('./firebase', () => ({
  db: {}
}));

describe('Dashboard UI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.setItem('protrade_auth', 'test-token');
  });

  it('renders the System Data Inventory table with Signals Found column', async () => {
    render(<App />);

    expect(screen.getByText(/System Data Inventory/i)).toBeInTheDocument();
    
    await waitFor(() => {
      expect(screen.getByText(/40 days/i)).toBeInTheDocument();
      expect(screen.getByText(/100 symbols/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Signals Found/i)).toBeInTheDocument();
    expect(screen.getByText(/1 signals/i)).toBeInTheDocument();
  });

  it('renders RSI and Volatility in the Active Positions table', async () => {
    render(<App />);

    await waitFor(() => {
      const rsiHeader = screen.getAllByText(/RSI/i)[0];
      expect(rsiHeader).toBeInTheDocument();
      expect(screen.getByText('48.0')).toBeInTheDocument();
      expect(screen.getByText('2.50%')).toBeInTheDocument();
    });
  });

  it('renders Kite status section', async () => {
    render(<App />);
    expect(screen.getByText(/Kite Integration/i)).toBeInTheDocument();
  });
});
