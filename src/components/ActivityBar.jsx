import { Files, Search, GitBranch } from 'lucide-react'

export default function ActivityBar({ activePanel, onPanelClick, isDark }) {
  const items = [
    { id: 'explorer', icon: Files, title: 'Explorer' },
    { id: 'search', icon: Search, title: 'Search' },
    { id: 'git', icon: GitBranch, title: 'Source Control' }
  ]

  return (
    <div className={`w-12 flex flex-col items-center py-2 shrink-0 border-r z-20 ${isDark ? 'bg-[#333333] border-[#252526]' : 'bg-[#e8e8e8] border-[#dddddd]'}`}>
      <div className="flex-1 flex flex-col gap-4 w-full">
        {items.map(item => {
          const Icon = item.icon
          const isActive = activePanel === item.id
          return (
            <button
              key={item.id}
              onClick={() => onPanelClick(item.id)}
              title={item.title}
              className={`relative py-3 w-full transition-colors group flex justify-center items-center ${
                isActive 
                  ? (isDark ? 'text-white' : 'text-black') 
                  : (isDark ? 'text-[#858585] hover:text-white' : 'text-gray-500 hover:text-black')
              }`}
            >
              <Icon size={24} strokeWidth={isActive ? 1.5 : 1.5} />
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-blue-500" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
