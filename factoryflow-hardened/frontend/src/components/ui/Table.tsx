import { Children, isValidElement, type ReactNode, type ReactElement } from 'react'

interface ResponsiveTableProps {
  headers: string[]
  children: ReactNode
  emptyMessage?: string
  isEmpty?: boolean
}
interface TableRowProps { cells: ReactNode[]; mobileCard: ReactNode }

// Rows are rendered separately for each viewport. Never render a div inside a tbody
// or a tr inside a mobile div: that was invalid HTML and could break hydration.
export function ResponsiveTable({ headers, children, emptyMessage = 'No records found', isEmpty }: ResponsiveTableProps) {
  const rows = Children.toArray(children).filter(
    (child): child is ReactElement<TableRowProps> => isValidElement(child) && child.type === TableRow
  )
  if (isEmpty || rows.length === 0) return <div className="text-center py-12 text-slate-500 text-sm">{emptyMessage}</div>
  return <>
    <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-slate-200 text-left">
          {headers.map(h => <th key={h} scope="col" className="px-4 py-3 font-medium text-slate-600">{h}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(row => <tr key={row.key} className="hover:bg-slate-50">
            {row.props.cells.map((cell,i) => <td key={i} className="px-4 py-3 text-slate-700">{cell}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="md:hidden space-y-3">
      {rows.map(row => <div key={row.key} className="card p-4">{row.props.mobileCard}</div>)}
    </div>
  </>
}

/** Declarative row descriptor; ResponsiveTable owns DOM placement. */
export function TableRow(_props: TableRowProps) { return null }
