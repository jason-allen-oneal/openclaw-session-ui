import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// NOTE: React.StrictMode intentionally double-invokes certain lifecycles in dev,
// which causes duplicate Gateway WS handshakes. For a stable dev UX, we disable it.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
