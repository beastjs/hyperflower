import { createRoot } from 'octane'
import App from './App.btsx'
import './style.css'

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app container.')

createRoot(container).render(App, { docsUrl: 'https://beast-docs.vercel.app' })

// Follow the system color scheme using the theme's .dark tokens.
const scheme = matchMedia('(prefers-color-scheme: dark)')
const applyScheme = () => document.documentElement.classList.toggle('dark', scheme.matches)
applyScheme()
scheme.addEventListener('change', applyScheme)
