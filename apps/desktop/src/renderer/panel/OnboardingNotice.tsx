import { onboardingCan, onboardingCannot } from '../../shared/onboarding'

export function OnboardingNotice({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  return (
    <section className="notice" aria-label="What Companion can do">
      <h2>What Companion can do</h2>
      <ul>
        {onboardingCan.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h2>What Companion will not do</h2>
      <ul>
        {onboardingCannot.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <button type="button" className="primary" onClick={onDismiss}>
        Got it
      </button>
    </section>
  )
}
