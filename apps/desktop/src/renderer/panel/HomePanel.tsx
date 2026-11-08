import { useState } from 'react'
import type { FavoriteKind } from '../../shared/favorites'
import type { Reminder } from '../../shared/reminders'
import type { SessionSnapshot } from '../../shared/session'
import { SegmentedChoice } from './controls'

export function HomePanel({
  session,
  onNotice,
  onCompose
}: {
  session: SessionSnapshot
  onNotice: (notice: string | null) => void
  onCompose: (text: string) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<FavoriteKind>('application')
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  const [pendingDomain, setPendingDomain] = useState(false)
  const [reminderTitle, setReminderTitle] = useState('')
  const [reminderDate, setReminderDate] = useState('')
  const [reminderTime, setReminderTime] = useState('')
  const reminders = session.reminders.filter((reminder) =>
    ['scheduled', 'missed', 'fired'].includes(reminder.status)
  )

  const apps = session.favorites.filter((favorite) => favorite.kind === 'application').slice(0, 8)
  const sites = session.favorites.filter((favorite) => favorite.kind === 'website').slice(0, 8)

  async function save(confirmDomainChange = false): Promise<void> {
    const result = await window.companion.saveFavorite({
      kind,
      title,
      target,
      confirmDomainChange
    })
    if (result.status === 'needs_confirmation') {
      setPendingDomain(true)
      onNotice(result.summary)
      return
    }
    setPendingDomain(false)
    onNotice(result.status === 'saved' ? null : result.summary)
    if (result.status === 'saved') {
      setTitle('')
      setTarget('')
    }
  }

  return (
    <div className="page">
      <p className="lede">Apps, sites, and reminders. Chat is where you talk to Companion.</p>
      <section className="block">
        <h2>Favorite apps</h2>
        {apps.length === 0 ? <p className="muted">No apps yet. Add one below.</p> : null}
        {apps.length > 0 ? (
          <div className="rows">
            {apps.map((favorite) => (
              <FavoriteRow
                key={favorite.id}
                favoriteId={favorite.id}
                title={favorite.title}
                onNotice={onNotice}
              />
            ))}
          </div>
        ) : null}
      </section>
      <section className="block">
        <h2>Favorite websites</h2>
        {sites.length === 0 ? <p className="muted">No websites yet.</p> : null}
        {sites.length > 0 ? (
          <div className="rows">
            {sites.map((favorite) => (
              <FavoriteRow
                key={favorite.id}
                favoriteId={favorite.id}
                title={favorite.title}
                onNotice={onNotice}
              />
            ))}
          </div>
        ) : null}
      </section>
      <section className="block">
        <h2>Common tasks</h2>
        <div className="grid">
          <button type="button" className="tile" onClick={() => onCompose('Search for ')}>
            Search the internet
          </button>
          <button type="button" className="tile" onClick={() => onCompose('Remind me to ')}>
            Set a reminder
          </button>
          <button
            type="button"
            className="tile"
            onClick={() =>
              void window.companion
                .enlargeText()
                .then(() => onNotice('I made the text in this assistant larger.'))
            }
          >
            Make text bigger
          </button>
          <button type="button" className="tile" onClick={() => onCompose('Explain this screen')}>
            Explain my screen
          </button>
          <button
            type="button"
            className="tile"
            onClick={() =>
              void window.companion
                .launchBundle('com.apple.mail')
                .then((result) => onNotice(result.summary))
            }
          >
            Open email
          </button>
          <button
            type="button"
            className="tile"
            onClick={() => void window.companion.openPanel('help')}
          >
            Call for help
          </button>
        </div>
      </section>
      <section className="block">
        <h2>Reminders</h2>
        <p className="muted">
          Companion can remind you only while it is open. If it was quit, missed reminders show here
          the next time it starts.
        </p>
        {reminders.length === 0 ? <p className="muted">No reminders yet.</p> : null}
        {reminders.length > 0 ? (
          <div className="rows">
            {reminders.map((reminder) => (
              <ReminderRow key={reminder.id} reminder={reminder} onNotice={onNotice} />
            ))}
          </div>
        ) : null}
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault()
            const [year, month, day] = reminderDate.split('-').map(Number)
            const [hour, minute] = reminderTime.split(':').map(Number)
            if (
              !reminderTitle.trim() ||
              !Number.isInteger(year) ||
              !Number.isInteger(month) ||
              !Number.isInteger(day) ||
              !Number.isInteger(hour) ||
              !Number.isInteger(minute)
            ) {
              onNotice('Add a title, a date, and a time.')
              return
            }
            void window.companion
              .createReminder({
                title: reminderTitle,
                year,
                month: month ?? 1,
                day: day ?? 1,
                hour: hour ?? 0,
                minute: minute ?? 0,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
              })
              .then((result) => {
                onNotice(result.summary)
                if (result.status === 'saved') {
                  setReminderTitle('')
                  setReminderDate('')
                  setReminderTime('')
                }
              })
          }}
        >
          <input
            name="reminder"
            aria-label="Reminder"
            autoComplete="off"
            value={reminderTitle}
            onChange={(event) => setReminderTitle(event.target.value)}
            placeholder="Call the pharmacy"
          />
          <input
            name="reminder-date"
            aria-label="Reminder date"
            type="date"
            autoComplete="off"
            value={reminderDate}
            onChange={(event) => setReminderDate(event.target.value)}
          />
          <input
            name="reminder-time"
            aria-label="Reminder time"
            type="time"
            autoComplete="off"
            value={reminderTime}
            onChange={(event) => setReminderTime(event.target.value)}
          />
          <button type="submit" className="primary">
            Save reminder
          </button>
        </form>
      </section>
      <section className="block">
        <h2>Add a favorite</h2>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault()
            void save(pendingDomain)
          }}
        >
          <SegmentedChoice
            label="Favorite type"
            value={kind}
            options={[
              { value: 'application', label: 'App' },
              { value: 'website', label: 'Website' }
            ]}
            onChange={setKind}
          />
          <input
            name="favorite-name"
            aria-label="Favorite name"
            autoComplete="off"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Name"
          />
          <input
            name="favorite-target"
            aria-label={kind === 'application' ? 'Bundle ID' : 'Website address'}
            autoComplete="off"
            spellCheck={false}
            value={target}
            onChange={(event) => {
              setTarget(event.target.value)
              setPendingDomain(false)
            }}
            placeholder={kind === 'application' ? 'com.apple.TextEdit' : 'https://example.com'}
          />
          <button type="submit" className="primary">
            {pendingDomain ? 'Save the new domain' : 'Save favorite'}
          </button>
        </form>
      </section>
    </div>
  )
}

function ReminderRow({
  reminder,
  onNotice
}: {
  reminder: Reminder
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  const when = new Intl.DateTimeFormat(undefined, {
    timeZone: reminder.timezone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(reminder.triggerAtUtc))
  const status =
    reminder.status === 'missed'
      ? 'You missed this reminder.'
      : reminder.status === 'fired'
        ? 'This reminder is due.'
        : when
  return (
    <div className="favorite-row">
      <div className="tile" title={reminder.title}>
        <strong>{reminder.title}</strong>
        <span className="muted">{status}</span>
      </div>
      {reminder.status === 'scheduled' ? (
        <button
          type="button"
          className="quiet"
          aria-label={`Cancel ${reminder.title}`}
          onClick={() =>
            void window.companion
              .cancelReminder(reminder.id)
              .then(() => onNotice('I cancelled that reminder.'))
          }
        >
          Cancel
        </button>
      ) : (
        <button
          type="button"
          className="quiet"
          onClick={() => void window.companion.completeReminder(reminder.id)}
        >
          Done
        </button>
      )}
    </div>
  )
}

function FavoriteRow({
  favoriteId,
  title,
  onNotice
}: {
  favoriteId: string
  title: string
  onNotice: (notice: string | null) => void
}): React.JSX.Element {
  return (
    <div className="favorite-row">
      <button
        type="button"
        className="tile"
        title={title}
        onClick={() =>
          void window.companion
            .launchFavorite(favoriteId)
            .then((result) => onNotice(result.summary))
        }
      >
        <strong>{title}</strong>
      </button>
      <button
        type="button"
        className="quiet"
        aria-label={`Move ${title} up`}
        onClick={() => void window.companion.moveFavorite(favoriteId, 'up')}
      >
        Up
      </button>
      <button
        type="button"
        className="quiet"
        aria-label={`Move ${title} down`}
        onClick={() => void window.companion.moveFavorite(favoriteId, 'down')}
      >
        Down
      </button>
      <button
        type="button"
        className="quiet"
        aria-label={`Remove ${title}`}
        onClick={() => void window.companion.deleteFavorite(favoriteId)}
      >
        Remove
      </button>
    </div>
  )
}
