import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload()
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex flex-col items-center justify-center h-full w-full p-6 bg-[#0d1118] text-[#f2f7ff] select-none text-center">
          <div className="w-12 h-12 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mb-4 shadow-lg shadow-rose-950/20">
            <AlertTriangle size={24} />
          </div>
          <h2 className="text-base font-semibold text-zinc-100 mb-1.5">
            {this.props.title || 'Component Error'}
          </h2>
          <p className="text-xs text-zinc-400 max-w-md mb-4 leading-relaxed">
            {this.state.error?.message || 'An unexpected rendering error occurred in this panel.'}
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-black text-xs font-medium transition-colors shadow cursor-pointer"
          >
            <RefreshCw size={12} />
            <span>Reload Component</span>
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
