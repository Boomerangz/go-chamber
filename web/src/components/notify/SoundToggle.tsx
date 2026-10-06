import { Volume2, VolumeX } from 'lucide-react'
import { useState } from 'react'
import { play, setSoundOn, soundOn } from '../../lib/chime'
import { icon } from '../icon'
import './toggles.css'

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
      className="btn btn-ghost btn-icon sound-toggle"
      aria-label="Sounds"
      aria-pressed={on}
      title={on ? 'Sounds are on' : 'Chime when an agent needs me or finishes'}
      onClick={toggle}
    >
      {on ? <Volume2 {...icon(16)} /> : <VolumeX {...icon(16)} />}
    </button>
  )
}
