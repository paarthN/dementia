import { onboardingCan, onboardingCannot, removalSteps } from '../../shared/onboarding'

export function HelpPanel(): React.JSX.Element {
  return (
    <div>
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
      <p className="muted">
        Ask someone you trust for help at the computer. If you are in danger, use the emergency
        features on your phone.
      </p>
      <h2>Removing Companion</h2>
      <ul>
        {removalSteps.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}
