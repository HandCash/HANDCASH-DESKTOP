import { middleEllipsisParts } from './middleEllipsis'

export function MiddleEllipsisName({ className, label }: { className: string; label: string }) {
  const [head, tail] = middleEllipsisParts(label)
  return (
    <strong className={`${className} middle-ellipsis`} title={label}>
      <span className="middle-ellipsis-head">{head}</span>
      {tail ? <span className="middle-ellipsis-tail">{tail}</span> : null}
    </strong>
  )
}
