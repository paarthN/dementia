import { useId } from 'react'
import { Item as RadioItem, Root as RadioGroup } from '@radix-ui/react-radio-group'
import { Range, Root as SliderRoot, Thumb as SliderThumb, Track } from '@radix-ui/react-slider'
import { Root as SwitchRoot, Thumb as SwitchThumb } from '@radix-ui/react-switch'

export function SegmentedChoice<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}): React.JSX.Element {
  const labelId = useId()
  return (
    <div className="group">
      <p className="label" id={labelId}>
        {label}
      </p>
      <RadioGroup
        className="segment"
        value={value}
        aria-labelledby={labelId}
        onValueChange={(next) => onChange(next as T)}
      >
        {options.map((option) => (
          <RadioItem key={option.value} className="segment-item" value={option.value}>
            {option.label}
          </RadioItem>
        ))}
      </RadioGroup>
    </div>
  )
}

export function SwitchRow({
  label,
  checked,
  onCheckedChange
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="switch-row">
      <label htmlFor={id}>{label}</label>
      <SwitchRoot id={id} className="switch" checked={checked} onCheckedChange={onCheckedChange}>
        <SwitchThumb className="switch-thumb" />
      </SwitchRoot>
    </div>
  )
}

export function ScaleControl({
  value,
  onChange
}: {
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const shown = value.toFixed(1)
  return (
    <div className="group">
      <div className="scale-head">
        <p className="label">Content scale</p>
        <span className="value">{shown}</span>
      </div>
      <SliderRoot
        className="scale"
        min={1}
        max={1.6}
        step={0.1}
        value={[value]}
        onValueChange={(next) => {
          const raw = next[0]
          if (raw === undefined) {
            return
          }
          onChange(Math.round(raw * 10) / 10)
        }}
      >
        <Track className="scale-track">
          <Range className="scale-range" />
        </Track>
        <SliderThumb className="scale-thumb" aria-label="Content scale" aria-valuetext={shown} />
      </SliderRoot>
    </div>
  )
}
