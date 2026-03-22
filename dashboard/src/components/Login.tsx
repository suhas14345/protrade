import React, { useState } from 'react';
import { Lock, User, Terminal } from 'lucide-react';

interface LoginProps {
  onLogin: (token: string) => void;
}

const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    // Hardcoded credentials for Shadow Mode
    if (username === 'suhas14345' && password === 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6') {
      const token = 'protrade_token_' + Date.now();
      localStorage.setItem('protrade_auth', token);
      onLogin(token);
    } else {
      setError('Invalid credentials. Access denied.');
    }
  };

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#020617',
      color: '#f8fafc',
      fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{
        width: '100%',
        maxWidth: '400px',
        background: '#0f172a',
        padding: '2.5rem',
        borderRadius: '16px',
        border: '1px solid #1e293b',
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{
            width: '48px',
            height: '48px',
            background: 'rgba(16, 185, 129, 0.1)',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 1rem'
          }}>
            <Terminal size={24} color="#10b981" />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>PROTRADE <span style={{ color: '#444' }}>| ACCESS</span></h2>
          <p style={{ color: '#64748b', fontSize: '0.875rem', marginTop: '0.5rem' }}>Secure Terminal Entry Required</p>
        </div>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#94a3b8' }}>Username</label>
            <div style={{ position: 'relative' }}>
              <User size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="suhas..."
                style={{
                  width: '100%',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '12px 12px 12px 40px',
                  color: '#fff',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: '#94a3b8' }}>Access Sequence (Password)</label>
            <div style={{ position: 'relative' }}>
              <Lock size={18} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="guid..."
                style={{
                  width: '100%',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '12px 12px 12px 40px',
                  color: '#fff',
                  outline: 'none',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          </div>

          {error && (
            <div style={{ color: '#ef4444', fontSize: '0.875rem', marginBottom: '1rem', textAlign: 'center' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            style={{
              width: '100%',
              background: '#10b981',
              color: '#020617',
              border: 'none',
              borderRadius: '8px',
              padding: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              transition: 'background 0.2s'
            }}
          >
            Authorize Entry
          </button>
        </form>

        <div style={{ marginTop: '2rem', textAlign: 'center', fontSize: '0.75rem', color: '#334155' }}>
          PROTRADE V2.1 ALPHA | SECURED ENVIRONMENT
        </div>
      </div>
    </div>
  );
};

export default Login;
