import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { cn } from '../../utils/cn';

export function StreamingLog({ logs, status = 'working' }) {
  const containerRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (containerRef.current && stickToBottomRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, status]);

  const handleScroll = () => {
    const element = containerRef.current;
    if (!element) return;
    stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };

  return (
    <div className="flex flex-col w-full rounded-md border border-neutral-800 bg-neutral-950/50 overflow-hidden text-sm font-mono shadow-inner">
      <div className="flex items-center justify-between px-3 py-2 bg-neutral-900 border-b border-neutral-800 text-neutral-400 text-xs font-semibold tracking-wider uppercase">
        <span>Execution Log</span>
        {status === 'working' && <Loader2 size={12} className="animate-spin text-blue-500" />}
      </div>
      <div 
        ref={containerRef}
        onScroll={handleScroll}
        className="flex flex-col p-3 max-h-64 overflow-y-auto space-y-2"
      >
        <AnimatePresence initial={false}>
          {logs.map((log) => {
            const LogIcon = log.status === 'working' ? Loader2 : log.status === 'failed' ? AlertTriangle : log.icon || CheckCircle2;
            
            return (
              <motion.div
                key={log.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2 }}
                className={cn(
                  "flex items-start space-x-2 text-neutral-300",
                  log.status === 'working' ? 'text-blue-400' : log.status === 'failed' ? 'text-red-400' : 'text-neutral-400'
                )}
              >
                <div className="mt-0.5 shrink-0">
                  {log.status === 'working' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <LogIcon size={14} className={log.status === 'complete' ? 'text-green-500' : ''} />
                  )}
                </div>
                <div className="flex-1 leading-snug">
                  <span className="break-words">{log.label}</span>
                  {log.detail && (
                    <div className="text-xs text-neutral-500 mt-0.5 whitespace-pre-wrap">{log.detail}</div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        
        {logs.length === 0 && status === 'working' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex items-center space-x-2 text-neutral-500"
          >
            <Loader2 size={14} className="animate-spin" />
            <span>Starting...</span>
          </motion.div>
        )}
      </div>
    </div>
  );
}
