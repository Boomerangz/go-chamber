import { useState } from 'react'
import { play, setSoundOn, soundOn } from '../../lib/chime'

// SoundToggle turns the chimes on or off; turning them on plays one, which
// also lets the browser start audio from this click.
export default function SoundToggle() {
  const [on, setOn] = useState(soundOn)
  const toggle = () => {
    setSoundOn(!on)
    setOn(!on)
    if (!on) play('done')
  }
  return (
    <button
      type="button"
      className="btn btn-ghost sound-toggle"
      aria-label="Sounds"
      aria-pressed={on}
      title={on ? 'Sounds are on' : 'Chime when an agent needs me or finishes'}
      onClick={toggle}
    >
      {on ? '🔊' : '🔇'}
    </button>
  )
}
