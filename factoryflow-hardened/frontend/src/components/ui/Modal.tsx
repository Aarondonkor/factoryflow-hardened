import { useEffect, useId, useRef, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  const id=useId()
  const dialogRef=useRef<HTMLDivElement>(null)
  const closeRef=useRef(onClose)
  closeRef.current=onClose

  useEffect(() => {
    if (!open) return
    const previous=document.activeElement instanceof HTMLElement ? document.activeElement : null
    const originalOverflow=document.body.style.overflow
    document.body.style.overflow='hidden'
    const dialog=dialogRef.current
    dialog?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
    const onKeyDown=(e: KeyboardEvent) => {
      if(e.key==='Escape'){e.preventDefault(); closeRef.current();return}
      if(e.key!=='Tab'||!dialog) return
      const focusable=Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )).filter(el=>el.getClientRects().length>0)
      if(focusable.length===0){e.preventDefault();dialog.focus();return}
      const first=focusable[0], last=focusable[focusable.length-1]
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus()}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus()}
    }
    document.addEventListener('keydown',onKeyDown)
    return ()=>{document.removeEventListener('keydown',onKeyDown);document.body.style.overflow=originalOverflow;previous?.focus()}
  },[open])

  if (!open) return null
  const sizes={sm:'max-w-md',md:'max-w-lg',lg:'max-w-2xl'}
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div className="fixed inset-0 bg-brand-950/50 backdrop-blur-sm" aria-hidden="true" onClick={onClose}/>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}
      className={`relative w-full ${sizes[size]} card p-6 shadow-elevated max-h-[90vh] overflow-y-auto animate-fade-in`}>
      <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4">
        <h2 id={id} className="font-display text-lg font-bold text-slate-900">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close dialog"
          className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
      </div>
      {children}
    </div>
  </div>
}
