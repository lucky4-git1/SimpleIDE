import { useState, useEffect, useRef, useCallback } from 'react'
import { Settings, X, Eye, EyeOff, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'
import { getApiConfig, PROVIDER_CATALOG, saveApiConfig, listProviderModels, resolveModelOptions } from '../services/aiService'

export default function AISettingsModal({ isOpen, onClose, isDark }) {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(PROVIDER_CATALOG.openai.models[0])
  const [provider, setProvider] = useState('openai')
  const [showKey, setShowKey] = useState(false)
  const [modelOptions, setModelOptions] = useState([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsStatus, setModelsStatus] = useState({ ok: null, text: '' })
  const inputRef = useRef(null)

  const loadOptions = useCallback(async (nextProvider, currentModel, { apiKey: candidateKey, force = false } = {}) => {
    setModelsLoading(true)
    try {
      const { models, liveModels, error } = await listProviderModels(nextProvider, { apiKey: candidateKey, force })
      setModelOptions(resolveModelOptions({ provider: nextProvider, currentModel, liveModels: liveModels || models }))
      if (error) {
        setModelsStatus({ ok: false, text: `Key check failed (${error}). Showing known models.` })
      } else if (liveModels) {
        setModelsStatus({ ok: true, text: `Key works — ${liveModels.length} models available.` })
      } else {
        setModelsStatus({ ok: null, text: '' })
      }
    } catch (error) {
      setModelOptions(resolveModelOptions({ provider: nextProvider, currentModel }))
      setModelsStatus({ ok: false, text: `Key check failed (${error.message}). Showing known models.` })
    } finally {
      setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      getApiConfig().then(config => {
        setApiKey(config.apiKey)
        setModel(config.model)
        setProvider(config.provider)
        setModelsStatus({ ok: null, text: '' })
        loadOptions(config.provider, config.model)
      })
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, loadOptions])

  if (!isOpen) return null

  const handleSave = async () => {
    await saveApiConfig({ apiKey, model, provider })
    onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm" onKeyDown={handleKeyDown}>
      <div className={`w-full max-w-md rounded-lg shadow-2xl border ${isDark ? 'bg-[#252526] border-[#454545]' : 'bg-white border-zinc-300'}`}>
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-[#454545]' : 'border-zinc-200'}`}>
          <div className="flex items-center gap-2">
            <Settings size={16} className={isDark ? 'text-zinc-400' : 'text-zinc-500'} />
            <span className={`text-sm font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>AI Settings</span>
          </div>
          <button onClick={onClose} className={`p-1 rounded ${isDark ? 'hover:bg-[#333] text-zinc-400' : 'hover:bg-zinc-100 text-zinc-500'}`}>
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Provider */}
          <div>
            <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                const nextProvider = e.target.value
                setProvider(nextProvider)
                const fallback = PROVIDER_CATALOG[nextProvider].models[0]
                setModel(fallback)
                loadOptions(nextProvider, fallback, { force: true })
              }}
              className={`w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:border-blue-500 ${
                isDark ? 'bg-[#3c3c3c] border-[#555] text-zinc-200' : 'bg-zinc-50 border-zinc-300 text-zinc-900'
              }`}
            >
              {Object.entries(PROVIDER_CATALOG).map(([id, details]) => (
                <option key={id} value={id}>{details.label}</option>
              ))}
            </select>
          </div>

          {/* API Key */}
          <div>
            <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>API Key</label>
            <div className="relative">
              <input
                ref={inputRef}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={PROVIDER_CATALOG[provider]?.keyPlaceholder || 'API key'}
                className={`w-full px-3 py-1.5 pr-10 text-sm border rounded focus:outline-none focus:border-blue-500 font-mono ${
                  isDark ? 'bg-[#3c3c3c] border-[#555] text-zinc-200 placeholder-zinc-600' : 'bg-zinc-50 border-zinc-300 text-zinc-900 placeholder-zinc-400'
                }`}
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className={`absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded ${isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700'}`}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
              Your key is stored encrypted on this device. Never sent anywhere except the AI provider.
            </p>
            <button
              type="button"
              onClick={() => loadOptions(provider, model, { apiKey: apiKey?.trim() ? apiKey.trim() : undefined, force: true })}
              disabled={modelsLoading}
              className={`mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${isDark ? 'bg-[#3c3c3c] hover:bg-[#4a4a4a] text-zinc-200' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'}`}
            >
              <RefreshCw size={12} className={modelsLoading ? 'prime-spin' : ''} />
              {modelsLoading ? 'Checking key…' : 'Check key & load my models'}
            </button>
            {modelsStatus.text && (
              <p className={`mt-1.5 flex items-center gap-1.5 text-xs ${modelsStatus.ok ? (isDark ? 'text-emerald-400' : 'text-emerald-600') : (isDark ? 'text-amber-400' : 'text-amber-600')}`}>
                {modelsStatus.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {modelsStatus.text}
              </p>
            )}
          </div>

          {/* Model */}
          <div>
            <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={`w-full px-3 py-1.5 text-sm border rounded focus:outline-none focus:border-blue-500 ${
                isDark ? 'bg-[#3c3c3c] border-[#555] text-zinc-200' : 'bg-zinc-50 border-zinc-300 text-zinc-900'
              }`}
            >
              {(modelOptions.length ? modelOptions : [{ id: model, current: true }]).map(option => (
                <option key={option.id} value={option.id}>
                  {option.current ? `● ${option.id} (current)` : option.id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={`flex justify-end gap-2 px-4 py-3 border-t ${isDark ? 'border-[#454545]' : 'border-zinc-200'}`}>
          <button
            onClick={onClose}
            className={`px-3 py-1.5 text-xs rounded transition-colors ${isDark ? 'hover:bg-[#333] text-zinc-300' : 'hover:bg-zinc-100 text-zinc-600'}`}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
