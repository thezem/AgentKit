import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/** Assistant prose. Measure is capped by the thread column; code gets its own surface. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('text-[15px] leading-7 [&>*+*]:mt-3', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground" />,
          ul: (props) => <ul {...props} className="list-disc space-y-1 pl-5 marker:text-muted-foreground" />,
          ol: (props) => <ol {...props} className="list-decimal space-y-1 pl-5 marker:text-muted-foreground" />,
          h1: (props) => <h3 {...props} className="text-lg font-semibold tracking-tight" />,
          h2: (props) => <h3 {...props} className="text-base font-semibold tracking-tight" />,
          h3: (props) => <h4 {...props} className="font-semibold" />,
          blockquote: (props) => <blockquote {...props} className="text-muted-foreground italic" />,
          table: (props) => (
            <div className="overflow-x-auto">
              <table {...props} className="w-full text-sm [&_td]:border-t [&_td]:px-2 [&_td]:py-1.5 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium" />
            </div>
          ),
          code: ({ className: lang, children, ...props }) => {
            const block = /language-/.test(lang ?? '') || String(children).includes('\n')
            if (!block) return <code {...props} className="rounded-[5px] bg-code px-1.5 py-0.5 font-mono text-[13px]">{children}</code>
            return <code {...props} className="font-mono text-[13px] leading-6">{children}</code>
          },
          pre: (props) => <pre {...props} className="overflow-x-auto rounded-lg border bg-code px-4 py-3" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
