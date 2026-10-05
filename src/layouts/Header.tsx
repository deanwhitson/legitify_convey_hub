import React from 'react'
import { Bell, Search, User, Moon, Sun, Home } from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/utils/cn'
import { useNavigate } from 'react-router-dom'
import { getSession, onSessionChange } from '@/lib/api/session'
import { sessionUserDisplayName } from '@/lib/sessionIdentity'

interface HeaderProps {
  className?: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

// Display identity comes only from the verified session user relayed by the
// BFF login response. Nothing is fabricated: with no usable field the header
// shows a neutral label rather than a placeholder person.
export function sessionDisplayName(user: Record<string, unknown> | null | undefined): string {
  return sessionUserDisplayName(user) || 'Signed-in user'
}

export function sessionSubtitle(user: Record<string, unknown> | null | undefined): string {
  if (!user) return ''
  return [
    text(user.role_name) || text(user.roleName),
    text(user.accountable_institution_name) || text(user.institution_name),
  ].filter(Boolean).join(' · ')
}

const Header: React.FC<HeaderProps> = ({ className }) => {
  const [isDarkMode, setIsDarkMode] = React.useState(false)
  const navigate = useNavigate()
  // Subscribed to the session module itself (the same source useAuth wraps),
  // so the name updates on login, clears on logout and switches on account
  // change without depending on provider mount order.
  const session = React.useSyncExternalStore(onSessionChange, getSession, getSession)
  const displayName = sessionDisplayName(session?.user)
  const subtitle = sessionSubtitle(session?.user)

  React.useEffect(() => {
    const isDark = localStorage.getItem('darkMode') === 'true'
    setIsDarkMode(isDark)
    if (isDark) {
      document.documentElement.classList.add('dark')
    }
  }, [])

  const toggleDarkMode = () => {
    const newDarkMode = !isDarkMode
    setIsDarkMode(newDarkMode)
    localStorage.setItem('darkMode', newDarkMode.toString())
    document.documentElement.classList.toggle('dark')
  }

  const goHome = () => {
    navigate('/')
  }

  return (
    <header className={cn(
      'h-16 border-b border-gray-200 dark:border-navy-700 bg-white dark:bg-navy-800',
      className
    )}>
      <div className="h-full px-6 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search cases, documents, clients..."
              className="pl-10 pr-4 py-2 w-80 border border-gray-300 dark:border-navy-600 rounded-lg bg-gray-50 dark:bg-navy-900 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
            />
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <Button variant="ghost" size="sm" onClick={goHome} className="flex items-center space-x-2">
            <Home className="h-5 w-5" />
            <span>Home</span>
          </Button>
          
          <Button variant="ghost" size="sm" className="relative">
            <Bell className="h-5 w-5" />
            <span className="absolute -top-1 -right-1 h-2 w-2 bg-teal-500 rounded-full"></span>
          </Button>
          
          <Button variant="ghost" size="sm" onClick={toggleDarkMode}>
            {isDarkMode ? (
              <Sun className="h-5 w-5" />
            ) : (
              <Moon className="h-5 w-5" />
            )}
          </Button>

          <div className="flex items-center space-x-2 pl-3 border-l border-gray-200 dark:border-navy-700">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-teal-500 to-navy-600 flex items-center justify-center">
              <User className="h-4 w-4 text-white" />
            </div>
            <div className="hidden sm:block">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{displayName}</p>
              {subtitle ? <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p> : null}
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}

export { Header }
