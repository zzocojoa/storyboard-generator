import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './styles.css';

const root: HTMLElement | null = document.getElementById('root');
if (root === null) throw new Error('ROOT_ELEMENT_NOT_FOUND');
ReactDOM.createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
