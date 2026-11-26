import { useEffect, useMemo, useState } from 'react';
import type {
  InstanceContent,
  InstanceEntry,
  InstanceLoader,
  LoaderKind,
  ProgressEvent,
  VersionSummary,
} from '../../shared/api';
import { defaultInstance, INSTANCE_COLORS } from '../../shared/instances';
import { VersionMindMap } from './VersionMindMap';

type Props = {
  versions: VersionSummary[];
  loadingVersions: boolean;
  progress: ProgressEvent | null;
  percent: number;
  onReloadVersions: () => Promise<void> | void;
  onCancel: () => void;
  onCreate: (entry: InstanceEntry, modPaths?: string[]) => void;
};

/** Every loader the app knows about. Vanilla, Fabric, Forge and Quilt can be set
 * up today; the rest are listed as planned so the picker matches what launchers
 * like Prism offer without pretending the installs exist. */
const LOADERS: { id: string; label: string; blurb: string; planned?: boolean }[] = [
  { id: 'vanilla', label: 'Vanilla', blurb: 'The plain game with nothing loaded on top.' },
  { id: 'fabric', label: 'Fabric', blurb: 'Lightweight loader for modern mods.' },
  { id: 'forge', label: 'Forge', blurb: 'The classic loader for big modpacks.' },
  { id: 'neoforge', label: 'NeoForge', blurb: 'Forge fork maintained for newer versions.' },
  { id: 'babric', label: 'Babric', blurb: 'Fabric toolchain for beta 1.7.3.' },
  { id: 'bta', label: 'BTA', blurb: 'Better Than Adventure, the beta 1.7.3 overhaul.' },
  { id: 'java-agent', label: 'Java Agent', blurb: 'Tweaks loaded through a JVM agent.' },
  { id: 'legacyfabric', label: 'Legacy Fabric', blurb: 'Fabric for 1.12 and older.' },
  { id: 'liteloader', label: 'LiteLoader', blurb: 'Small loader for 1.12.2 and older versions.' },
  {
    id: 'modloader',
    label: "Risugami's ModLoader",
    blurb: 'The original 1.6-era loader.',
  },
  { id: 'nilloader', label: 'NilLoader', blurb: 'Runtime patches applied through a JVM agent.' },
  { id: 'ornithe', label: 'Ornithe', blurb: 'Fabric for old versions with legacy mappings.' },
  { id: 'quilt', label: 'Quilt', blurb: 'Fabric-compatible loader with extra APIs.' },
  { id: 'rift', label: 'Rift', blurb: 'Loader for 1.13-era mods.' },
  {
    id: 'modpack',
    label: 'Modpack',
    blurb: 'Modpack import is not built yet - pick Vanilla, Fabric, Forge or Quilt.',
    planned: true,
  },
];

const LATER = [
  { id: 'shaders', label: 'Shaders', blurb: 'Iris or OptiFine shader packs.' },
  { id: 'resourcepacks', label: 'Resource packs', blurb: 'Textures and sounds for this instance.' },
];

const STEPS = ['Loader', 'Version', 'Content', 'Name', 'Include'] as const;

const COPY = [
  {
    title: 'Pick a loader',
    sub: 'Vanilla, Fabric, Forge, NeoForge, Quilt, Legacy Fabric, LiteLoader, Babric, BTA, Ornithe, NilLoader, ModLoader, Rift and Java Agent work today - the greyed loaders are planned.',
  },
  {
    title: 'Choose a version',
    sub: 'Open a family like 26, then pick the exact build underneath it.',
  },
  {
    title: 'Mods, shaders and resource packs',
    sub: 'Add your own mod jars now - they are copied into the instance when it is created. Shaders and resource packs can follow later.',
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

export function InstanceWizard({
  versions,
  loadingVersions,
  progress,
  percent,
  onReloadVersions,
  onCancel,
  onCreate,
}: Props) {
  const [step, setStep] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [loader, setLoader] = useState<InstanceLoader>('vanilla');
  const [channel, setChannel] = useState<'release' | 'all'>('release');
  // The version filter lives here so the top bar search never narrows this list.
  const [versionFilter, setVersionFilter] = useState('');
  const [path, setPath] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(INSTANCE_COLORS[0].hex);
  const [content, setContent] = useState<InstanceContent>({
    vanilla: true,
    mods: false,
    primeMod: false,
  });
  const [install, setInstall] = useState<
    { status: 'idle' } | { status: 'installing' } | { status: 'error'; error: string }
  >({ status: 'idle' });
  const installing = install.status === 'installing';
  const [btaVersions, setBtaVersions] = useState<VersionSummary[]>([]);
  const [btaLoading, setBtaLoading] = useState(false);
  // A Java Agent install has no published artifact, so the jar is picked here.
  const [agentJar, setAgentJar] = useState('');
  // Mod jars chosen here are copied into the instance once its record exists.
  const [modFiles, setModFiles] = useState<string[]>([]);

  // BTA ships its own builds, so its list comes from BTA rather than Mojang's
  // manifest. It is fetched once, the first time the tile is picked.
  useEffect(() => {
    if (loader !== 'bta' || btaVersions.length > 0) return;
    let live = true;
    setBtaLoading(true);
    window.prime
      .btaVersions()
      .then((list) => {
        if (live) setBtaVersions(list);
      })
      .catch(() => {
        if (live) setBtaVersions([]);
      })
      .finally(() => {
        if (live) setBtaLoading(false);
      });
    return () => {
      live = false;
    };
  }, [loader, btaVersions.length]);

  const options = useMemo(() => {
    const needle = versionFilter.trim().toLowerCase();
    // BTA numbers its own builds (bta-v8.0.1) and is in no Minecraft manifest.
    const source = loader === 'bta' ? btaVersions : versions;
    return source.filter((version) => {
      if (loader !== 'bta' && version.loader) return false;
      if (loader !== 'bta' && channel === 'release' && version.type !== 'release') return false;
      return needle.length === 0 || version.id.toLowerCase().includes(needle);
    });
  }, [btaVersions, channel, loader, versionFilter, versions]);

  const loaderLabel = LOADERS.find((entry) => entry.id === loader)?.label ?? 'Vanilla';
  const instanceName = name.trim() || pending || '';
  const needsInstall =
    loader === 'fabric' ||
    loader === 'forge' ||
    loader === 'neoforge' ||
    loader === 'quilt' ||
    loader === 'legacyfabric' ||
    loader === 'liteloader' ||
    loader === 'babric' ||
    loader === 'ornithe' ||
    loader === 'nilloader' ||
    loader === 'bta' ||
    loader === 'modloader' ||
    loader === 'rift' ||
    loader === 'java-agent';
  const canNext =
    !installing &&
    (step === 1
      ? pending !== null && (loader !== 'java-agent' || agentJar.trim().length > 0)
      : step === 3
        ? instanceName.length > 0
        : true);

  const pickModFiles = async () => {
    const picked = await window.prime.pickMods();
    if (picked.length === 0) return;
    setModFiles((current) => [...current, ...picked.filter((file) => !current.includes(file))]);
    setContent((current) => ({ ...current, mods: true }));
  };

  const removeModFile = (file: string) => {
    const next = modFiles.filter((candidate) => candidate !== file);
    setModFiles(next);
    if (next.length === 0) setContent({ ...content, mods: false });
  };

  // The working loaders are real installs, not labels: run the same installer
  // the detail panel uses and only create the instance once a profile exists.
  const finish = async () => {
    if (!pending || installing) return;
    setInstall({ status: 'idle' });

    if (needsInstall) {
      setInstall({ status: 'installing' });
      const result = await window.prime.installLoader(
        loader as LoaderKind,
        pending,
        loader === 'java-agent' ? agentJar.trim() : undefined,
      );
      if (!result.ok || !result.versionId) {
        setInstall({
          status: 'error',
          error: result.error ?? `${loaderLabel} did not produce a playable profile.`,
        });
        return;
      }
      // The new loader profile has to be in the version list before the card
      // can resolve it, so refresh first and then create the instance.
      await onReloadVersions();
      onCreate(
        defaultInstance(result.versionId, { loader, name: instanceName, color, content }),
        modFiles,
      );
      return;
    }

    onCreate(defaultInstance(pending, { loader, name: instanceName, color, content }), modFiles);
  };

  const advance = () => {
    if (step === STEPS.length - 1) {
      void finish();
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
          <p className="setup-sub">
            {step === 1 && loader === 'bta'
              ? 'BTA ships its own builds - pick the release you want to play.'
              : COPY[step].sub}
          </p>
        </div>
        <div className="setup-head-side">
          <div className="setup-picks">
            <span className="chip subtle">{loaderLabel}</span>
            {pending ? <span className="chip subtle">{pending}</span> : null}
          </div>
          <button type="button" className="btn-ghost" disabled={installing} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </header>

      <div className={step === 1 ? 'setup-body map' : 'setup-body'}>
        {step === 0 ? (
          <>
            <div className="setup-grid">
              {LOADERS.map((option) => {
                const unavailable = option.planned === true;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={loader === option.id}
                    disabled={unavailable}
                    className={[
                      'setup-card',
                      loader === option.id ? 'on' : '',
                      unavailable ? 'unavailable' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (unavailable) return;
                      setLoader(option.id as InstanceLoader);
                      // Babric only exists for beta 1.7.3, which the release
                      // filter would hide.
                      if (option.id === 'babric') setChannel('all');
                    }}
                  >
                    <span className={`loader-mark ${option.id}`} aria-hidden="true" />
                    {loader === option.id ? (
                      <span className="setup-tick" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                    <span className="setup-card-head">
                      <span className="setup-card-title">{option.label}</span>
                      {unavailable ? <span className="chip soon">Not yet</span> : null}
                    </span>
                    <span className="setup-card-blurb">{option.blurb}</span>
                  </button>
                );
              })}
            </div>
            <p className="note setup-note">
              {needsInstall
                ? `${loaderLabel} installs when you press Create instance at the end - progress shows right in the wizard.`
                : 'Greyed loaders are planned and cannot be installed yet. Fabric, Forge, NeoForge, Quilt, Legacy Fabric, LiteLoader, Babric, BTA, Ornithe, NilLoader, ModLoader, Rift and Java Agent are the working choices today.'}
            </p>
          </>
        ) : null}

        {step === 1 ? (
          <div className="setup-stepmap">
            {loader === 'java-agent' ? (
              <div className="setup-agent">
                <label className="field">
                  <span>Agent jar</span>
                  <input
                    value={agentJar}
                    placeholder="C:\path\to\agent.jar"
                    spellCheck={false}
                    onChange={(event) => setAgentJar(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    void window.prime.pickAgent().then((picked) => {
                      if (picked) setAgentJar(picked);
                    });
                  }}
                >
                  Browse…
                </button>
              </div>
            ) : null}
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
              <label className="setup-version-filter">
                <input
                  value={versionFilter}
                  spellCheck={false}
                  placeholder="Filter versions"
                  aria-label="Filter versions"
                  onChange={(event) => setVersionFilter(event.target.value)}
                />
              </label>
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
                loader === 'bta'
                  ? btaLoading
                    ? 'Loading BTA builds…'
                    : 'BTA builds unavailable. Check your connection and reload.'
                  : loadingVersions
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
            <div className="setup-mods">
              <div className="setup-card setup-mods-card">
                <span className="setup-card-head">
                  <span className="setup-card-title">Mods</span>
                  <span className="chip subtle">
                    {modFiles.length === 0
                      ? 'Optional'
                      : `${modFiles.length} file${modFiles.length === 1 ? '' : 's'}`}
                  </span>
                </span>
                <span className="setup-card-blurb">
                  Jar files from your disk. They are copied into this instance's mods folder as
                  soon as it is created.
                </span>
                <div className="setup-mod-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={installing}
                    onClick={() => void pickModFiles()}
                  >
                    Add mod jars…
                  </button>
                </div>
                {modFiles.length > 0 ? (
                  <ul className="setup-file-list">
                    {modFiles.map((file) => {
                      const label = file.split(/[\\/]/).pop() ?? file;
                      return (
                        <li className="setup-file" key={file}>
                          <span title={file}>{label}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${label}`}
                            onClick={() => removeModFile(file)}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="note setup-mods-empty">
                    No mod files picked yet - you can also add them after the instance exists.
                  </p>
                )}
              </div>
              <div className="setup-grid setup-grid-later">
                {LATER.map((item) => (
                  <div className="setup-card static" key={item.id}>
                    <span className="chip subtle">Add later</span>
                    <span className="setup-card-title">{item.label}</span>
                    <span className="setup-card-blurb">{item.blurb}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="note setup-note">
              Picked mods are copied in when the instance is created. Shaders and resource packs
              can be added afterwards from the instance page.
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

      {install.status !== 'idle' ? (
        <div
          className={install.status === 'error' ? 'setup-status error' : 'setup-status'}
          role={install.status === 'error' ? 'alert' : 'status'}
        >
          <span className="setup-status-text">
            {install.status === 'error'
              ? `${loaderLabel} install failed: ${install.error}`
              : (progress?.label ?? `Installing ${loaderLabel} for ${pending ?? 'this version'}`)}
          </span>
          {install.status === 'error' ? (
            <button type="button" className="btn-ghost" onClick={() => void finish()}>
              Try again
            </button>
          ) : (
            <span className="setup-status-percent">{percent}%</span>
          )}
          {install.status === 'installing' ? (
            <div className="progress-track setup-status-track">
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      <footer className="setup-foot">
        <button
          type="button"
          className="btn-ghost"
          disabled={step === 0 || installing}
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
              disabled={index > furthest || installing}
              className={
                index === step ? 'setup-dot on' : index < step ? 'setup-dot done' : 'setup-dot'
              }
              onClick={() => goTo(index)}
            />
          ))}
        </div>
        <button type="button" className="btn-primary small" disabled={!canNext} onClick={advance}>
          {installing
            ? `Installing ${loaderLabel}…`
            : step === STEPS.length - 1
              ? needsInstall
                ? `Install ${loaderLabel} and create`
                : 'Create instance'
              : 'Next'}
        </button>
      </footer>
    </section>
  );
}
