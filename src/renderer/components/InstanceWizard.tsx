import { useMemo, useState } from 'react';
import type {
  InstanceContent,
  InstanceEntry,
  InstanceLoader,
  VersionSummary,
} from '../../shared/api';
import { defaultInstance, INSTANCE_COLORS } from '../../shared/instances';
import { VersionMindMap } from './VersionMindMap';

type Props = {
  versions: VersionSummary[];
  filter: string;
  loadingVersions: boolean;
  onCancel: () => void;
  onCreate: (entry: InstanceEntry) => void;
};

const LOADERS: { id: InstanceLoader; label: string; blurb: string }[] = [
  { id: 'vanilla', label: 'Vanilla', blurb: 'The plain game with nothing loaded on top.' },
  { id: 'fabric', label: 'Fabric', blurb: 'Lightweight loader for modern mods.' },
  { id: 'forge', label: 'Forge', blurb: 'The classic loader for big modpacks.' },
  { id: 'modpack', label: 'Modpack', blurb: 'Start from a pack and drop its files in later.' },
];

const LATER = [
  { id: 'mods', label: 'Mods', blurb: 'Loader-compatible mods from your own files.' },
  { id: 'shaders', label: 'Shaders', blurb: 'Iris or OptiFine shader packs.' },
  { id: 'resourcepacks', label: 'Resource packs', blurb: 'Textures and sounds for this instance.' },
];

const STEPS = ['Loader', 'Version', 'Content', 'Name', 'Include'] as const;

const COPY = [
  {
    title: 'Pick a loader',
    sub: 'Start from the plain game, a mod loader, or a modpack.',
  },
  {
    title: 'Choose a version',
    sub: 'Open a family like 26, then pick the exact build underneath it.',
  },
  {
    title: 'Mods, shaders and resource packs',
    sub: 'All three can be added later - setup only creates the instance.',
  },
  {
    title: 'Name and colour',
    sub: 'This is what the instance card shows on your Instances page.',
  },
  {
    title: 'What goes in',
    sub: 'Vanilla is always included. Tick anything else you want ready.',
  },
];

export function InstanceWizard({ versions, filter, loadingVersions, onCancel, onCreate }: Props) {
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [loader, setLoader] = useState<InstanceLoader>('vanilla');
  const [channel, setChannel] = useState<'release' | 'all'>('release');
  const [path, setPath] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(INSTANCE_COLORS[0].hex);
  const [content, setContent] = useState<InstanceContent>({
    vanilla: true,
    mods: false,
    primeMod: false,
  });

  const options = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return versions.filter((version) => {
      if (version.loader) return false;
      if (channel === 'release' && version.type !== 'release') return false;
      return needle.length === 0 || version.id.toLowerCase().includes(needle);
    });
  }, [channel, filter, versions]);

  const loaderLabel = LOADERS.find((entry) => entry.id === loader)?.label ?? 'Vanilla';
  const instanceName = name.trim() || pending || '';
  const canNext = step === 1 ? pending !== null : step === 3 ? instanceName.length > 0 : true;

  const advance = () => {
    if (step === STEPS.length - 1) {
      if (!pending) return;
      onCreate(defaultInstance(pending, { loader, name: instanceName, color, content }));
      return;
    }
    const nextStep = Math.min(STEPS.length - 1, step + 1);
    setStep(nextStep);
    setFurthest((current) => Math.max(current, nextStep));
  };

  const goTo = (index: number) => {
    if (index > furthest || index === step) return;
    setStep(index);
  };

  return (
    <section className="setup">
      <header className="setup-head">
        <div className="setup-titles">
          <span className="setup-eyebrow">
            New instance · step {step + 1} of {STEPS.length}
          </span>
          <h2 className="setup-title">{COPY[step].title}</h2>
          <p className="setup-sub">{COPY[step].sub}</p>
        </div>
        <div className="setup-head-side">
          <div className="setup-picks">
            <span className="chip subtle">{loaderLabel}</span>
            {pending ? <span className="chip subtle">{pending}</span> : null}
          </div>
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </header>

      <div className={step === 1 ? 'setup-body map' : 'setup-body'}>
        {step === 0 ? (
          <div className="setup-grid">
            {LOADERS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={loader === option.id}
                className={loader === option.id ? 'setup-card on' : 'setup-card'}
                onClick={() => setLoader(option.id)}
              >
                <span className={`loader-mark ${option.id}`} aria-hidden="true" />
                <span className="setup-card-title">{option.label}</span>
                <span className="setup-card-blurb">{option.blurb}</span>
              </button>
            ))}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="setup-stepmap">
            <div className="setup-mapbar">
              <div className="chip-row" role="group" aria-label="Channel">
                <button
                  type="button"
                  className={channel === 'release' ? 'chip toggle on' : 'chip toggle'}
                  onClick={() => setChannel('release')}
                >
                  Releases
                </button>
                <button
                  type="button"
                  className={channel === 'all' ? 'chip toggle on' : 'chip toggle'}
                  onClick={() => setChannel('all')}
                >
                  All versions
                </button>
              </div>
              <span className="muted">{options.length} versions</span>
              <span className="picker-hint">
                {pending ? `${pending} selected` : 'Open a branch, then pick a version'}
              </span>
            </div>
            <VersionMindMap
              versions={options}
              path={path}
              onPath={setPath}
              pending={pending}
              activeId={null}
              onPick={setPending}
              empty={
                loadingVersions
                  ? 'Loading version manifest…'
                  : versions.length === 0
                    ? 'Version manifest unavailable. Check your connection and reload.'
                    : 'No versions match that filter.'
              }
            />
          </div>
        ) : null}

        {step === 2 ? (
          <>
            <div className="setup-grid">
              {LATER.map((item) => (
                <div className="setup-card static" key={item.id}>
                  <span className="chip subtle">Add later</span>
                  <span className="setup-card-title">{item.label}</span>
                  <span className="setup-card-blurb">{item.blurb}</span>
                </div>
              ))}
            </div>
            <p className="note setup-note">
              Nothing is installed here: this step only says what the instance is for. Mods, shaders
              and resource packs can be added once the instance exists.
            </p>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <div className="setup-name">
              <div className="setup-fields">
                <label className="field">
                  <span>Instance name</span>
                  <input
                    value={name}
                    placeholder={pending ? `My ${pending} instance` : 'My instance'}
                    maxLength={48}
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <div className="field">
                  <span>Colour</span>
                  <div className="swatches" role="group" aria-label="Instance colour">
                    {INSTANCE_COLORS.map((option) => (
                      <button
                        key={option.hex}
                        type="button"
                        aria-label={option.label}
                        aria-pressed={color === option.hex}
                        className={color === option.hex ? 'swatch-dot on' : 'swatch-dot'}
                        style={{ backgroundColor: option.hex }}
                        onClick={() => setColor(option.hex)}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="setup-preview">
                <span
                  className="vcard-banner"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span className="vcard-body">
                  <span className="chip subtle">{loaderLabel}</span>
                  <strong className="vcard-id">{instanceName || 'Your instance'}</strong>
                  <span className="vcard-date">{pending ?? 'No version yet'}</span>
                </span>
              </div>
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <div className="checklist">
            <label className="check locked">
              <input type="checkbox" checked readOnly disabled />
              <span>
                <strong>Vanilla</strong>
                <em>Always included - the game itself.</em>
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={content.mods}
                onChange={(event) => setContent({ ...content, mods: event.target.checked })}
              />
              <span>
                <strong>Vanilla + mods</strong>
                <em>Mods for the {loaderLabel.toLowerCase()} setup.</em>
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={content.primeMod}
                onChange={(event) => setContent({ ...content, primeMod: event.target.checked })}
              />
              <span>
                <strong>Vanilla + Prime mod</strong>
                <em>Prime's own client mod on top of vanilla.</em>
              </span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={content.mods && content.primeMod}
                onChange={() => {
                  const both = !(content.mods && content.primeMod);
                  setContent({ ...content, mods: both, primeMod: both });
                }}
              />
              <span>
                <strong>Vanilla mods + Prime mod</strong>
                <em>Both of the options above, ready together.</em>
              </span>
            </label>
          </div>
        ) : null}
      </div>

      <footer className="setup-foot">
        <button
          type="button"
          className="btn-ghost"
          disabled={step === 0}
          onClick={() => setStep(Math.max(0, step - 1))}
        >
          Back
        </button>
        <div className="setup-dots" role="tablist" aria-label="Instance setup steps">
          {STEPS.map((label, index) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-label={label}
              aria-selected={index === step}
              aria-current={index === step ? 'step' : undefined}
              disabled={index > furthest}
              className={
                index === step ? 'setup-dot on' : index < step ? 'setup-dot done' : 'setup-dot'
              }
              onClick={() => goTo(index)}
            />
          ))}
        </div>
        <button type="button" className="btn-primary small" disabled={!canNext} onClick={advance}>
          {step === STEPS.length - 1 ? 'Create instance' : 'Next'}
        </button>
      </footer>
    </section>
  );
}
