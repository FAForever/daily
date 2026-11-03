import { useCallback, useEffect, useMemo, useState } from 'react';
import { Share2, Clock, Copy, Swords, Lock, ArrowRight } from 'lucide-react';
import { UNITS, findById } from './lib/units';
import type { Unit } from './lib/units';
import { todayKey, puzzleNumber, msUntilNextUTCDay, formatCountdown } from './lib/daily';
import { columnLabels } from './lib/compare';
import { fetchDailyState, reportSolved } from './lib/api';
import type { DailyState, Mode } from './lib/api';
import { buildShareImage } from './lib/shareImage';
import { Search } from './components/Search';
import { GuessGrid } from './components/GuessGrid';
import type { GuessResult } from './components/GuessGrid';
import { ColumnGuide } from './components/ColumnGuide';
import { UnitIcon } from './components/UnitIcon';

const STORE_KEY = 'faf-daily'; // normal daily (also migrates the legacy key)
const CHALLENGE_KEY = 'faf-daily-challenge'; // daily challenge, tracked separately
const DATA_URL = 'https://faforever.github.io/etfreeman-db/#/';

interface Saved {
  date: string;
  guesses: string[];
  solved: boolean;
}

function storeKey(mode: Mode): string {
  return mode === 'challenge' ? CHALLENGE_KEY : STORE_KEY;
}

// Per-mode progress, kept under separate keys so switching modes never resets
// the other one.
function loadSaved(mode: Mode): Saved {
  try {
    const raw =
      localStorage.getItem(storeKey(mode)) ??
      (mode === 'daily' ? localStorage.getItem('faf-unitdle') : null);
    if (raw) {
      const s = JSON.parse(raw) as Saved;
      if (s.date === todayKey()) return s;
    }
  } catch {
    /* ignore */
  }
  return { date: todayKey(), guesses: [], solved: false };
}

function loadGuesses(mode: Mode): Unit[] {
  return loadSaved(mode).guesses.map(findById).filter((u): u is Unit => !!u);
}

export default function App() {
  // Every visit opens on the normal daily; the challenge is only ever entered by
  // clicking through to it, so nobody lands in it by accident.
  const [mode, setMode] = useState<Mode>('daily');
  const [guesses, setGuesses] = useState<Unit[]>(() => loadGuesses(mode));
  const [state, setState] = useState<DailyState | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  // The server is the source of truth for the answer, the challenge lie, and
  // every grid cell — the browser never holds the answer until it has won.
  const solved = state?.solved ?? false;
  const answer = state?.answer ?? null;

  // Re-sync with the server whenever the mode or the set of guesses changes.
  useEffect(() => {
    let cancelled = false;
    setError(false);
    fetchDailyState(mode, guesses.map((g) => g.id))
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, guesses]);

  // Persist per-mode progress (ids only) so a refresh restores the board.
  useEffect(() => {
    const saved: Saved = { date: todayKey(), guesses: guesses.map((g) => g.id), solved };
    localStorage.setItem(storeKey(mode), JSON.stringify(saved));
  }, [mode, guesses, solved]);

  // Switch modes: load that mode's own saved progress, and clear stale board
  // state so the effect above re-fetches for the new mode.
  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setGuesses(loadGuesses(next));
    setState(null);
  }, []);

  useEffect(() => {
    if (!solved) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [solved]);

  // Count this browser's first solve of the day (once per mode) toward the
  // "solved today" tally, then reflect the updated count.
  useEffect(() => {
    if (!solved) return;
    const key = `faf-daily-counted-${mode}-${todayKey()}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    reportSolved(mode).then((counts) => {
      if (counts) setState((prev) => (prev ? { ...prev, stats: counts } : prev));
    });
  }, [solved, mode]);

  const guessedIds = useMemo(() => new Set(guesses.map((g) => g.id)), [guesses]);
  const pool = useMemo(() => UNITS.filter((u) => !guessedIds.has(u.id)), [guessedIds]);

  const onPick = useCallback(
    (u: Unit) => {
      if (solved) return;
      setGuesses((prev) => (prev.some((g) => g.id === u.id) ? prev : [...prev, u]));
    },
    [solved]
  );

  // Pair each guessed unit with the server's cells for it (same order). While a
  // sync is in flight the newest guess may have no cells yet — skip those rows.
  const results: GuessResult[] = useMemo(() => {
    const rows = state?.rows ?? [];
    const lie = state?.reveal?.lieCells;
    const out: GuessResult[] = [];
    guesses.forEach((unit, i) => {
      const cells = rows[i];
      if (cells) out.push({ unit, cells, lieCell: lie?.[i] });
    });
    return out;
  }, [guesses, state]);

  // Challenge: mask the hidden columns while the round is unsolved.
  const hidden = state && !solved && state.hidden.length ? new Set(state.hidden) : undefined;

  // Restoring a saved board: wait for the first server sync before choosing
  // between the search box and the win card, so a solved returner doesn't flash
  // the input. A fresh player (no saved guesses) skips this and sees the search
  // box immediately (so it can auto-focus). On error we fall through to search.
  const restoring = state === null && guesses.length > 0 && !error;

  const showIntro = !solved && guesses.length === 0;

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-[1240px] px-4 py-10 sm:py-14">
        {/* header */}
        <header className="border-b border-line pb-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-mono text-xl font-semibold uppercase tracking-[0.2em] text-slate-100">
                {mode === 'challenge' ? (
                  <>
                    FAF Daily <span className="text-accent">Challenge</span>
                  </>
                ) : (
                  <>
                    FAF <span className="text-accent">Daily</span>
                  </>
                )}
              </h1>
              <p className="mt-1.5 text-sm text-slate-400">
                {mode === 'challenge'
                  ? 'Two stats are hidden and one is a lie. Guess the unit.'
                  : 'Guess the daily Forged Alliance unit.'}
              </p>
            </div>
            <ModeSwitch mode={mode} onSwitch={switchMode} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] uppercase tracking-widest text-slate-500">
            <span>
              {mode === 'challenge' ? 'Challenge' : 'Puzzle'} #{puzzleNumber()}
            </span>
            <span className="text-slate-700">/</span>
            <span>{UNITS.length} units</span>
            <span className="text-slate-700">/</span>
            <span>{guesses.length} {guesses.length === 1 ? 'guess' : 'guesses'}</span>
            {state && (
              <>
                <span className="text-slate-700">/</span>
                <span className="text-accent">
                  {state.stats[mode].toLocaleString()} solved today
                </span>
              </>
            )}
          </div>
        </header>

        {/* how to play (landing) */}
        {showIntro && mode === 'daily' && (
          <section className="mt-6 border border-line bg-surface p-5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-accent">How to play</p>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
              A random Forged Alliance unit is picked every day. Type any unit to guess — each guess
              reveals how it compares to today's unit across its stats.{' '}
              <span className="font-semibold text-emerald-300">Green</span> = that attribute matches,{' '}
              <span className="font-semibold text-amber-300">amber</span> = partial match, and{' '}
              <span className="font-semibold text-slate-200">↑ / ↓</span> means the answer is higher / lower.
              Use the clues to identify it in as few tries as possible.
            </p>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-slate-500">
              Search by name, role, or faction — e.g. “aeon bomber”, “t3 land factory”.
            </p>
          </section>
        )}
        {showIntro && mode === 'challenge' && (
          <section className="mt-6 border border-accent/40 bg-surface p-5">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-accent">Daily challenge</p>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-300">
              A different unit from the normal daily, with a twist. Two attribute columns are{' '}
              <span className="inline-flex items-center gap-1 font-semibold text-slate-200">
                <Lock className="h-3 w-3" strokeWidth={3} />
                hidden
              </span>{' '}
              with no clue at all, and exactly one visible column is a{' '}
              <span className="font-semibold text-rose-300">lie</span>. You are not told which one. Every other
              column is honest. Solve it and the hidden stats and the lie are revealed.
            </p>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-slate-500">
              Same search as always - name, role, or faction.
            </p>
          </section>
        )}

        {/* input / win */}
        <div className="mt-7">
          {restoring ? (
            <div className="border border-line bg-surface px-4 py-3.5 font-mono text-[12px] uppercase tracking-widest text-slate-500">
              Loading your board…
            </div>
          ) : solved && answer ? (
            <WinCard
              answer={answer}
              guesses={guesses}
              now={now}
              challenge={mode === 'challenge'}
              // After the normal daily, point to the challenge — unless it's
              // already been solved today.
              onTryChallenge={
                mode === 'daily' && !loadSaved('challenge').solved ? () => switchMode('challenge') : undefined
              }
            />
          ) : (
            <Search pool={pool} onPick={onPick} />
          )}
        </div>

        {error && (
          <p className="mt-3 border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-[13px] text-rose-200">
            Couldn't reach the game server, so your last guess may not have registered. Check your
            connection and pick it again.
          </p>
        )}

        {/* legend */}
        {guesses.length > 0 && (
          <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-400">
            <Legend className="bg-emerald-500/20 ring-1 ring-inset ring-emerald-400/50" label="Match" />
            <Legend className="bg-amber-500/20 ring-1 ring-inset ring-amber-400/50" label="Partial" />
            <Legend className="bg-surface2 ring-1 ring-inset ring-line" label="Miss" />
            {mode === 'challenge' && !solved && (
              <span className="flex items-center gap-1.5 text-slate-500">
                <Lock className="h-3 w-3" strokeWidth={3} /> Hidden
              </span>
            )}
            <span className="text-slate-500">↑ / ↓ answer is higher / lower</span>
          </div>
        )}

        {/* challenge status */}
        {mode === 'challenge' && guesses.length > 0 && !solved && (
          <div className="mt-4 flex items-start gap-2 border border-accent/30 bg-surface px-4 py-2.5 text-[13px] text-slate-300">
            <Swords className="mt-0.5 h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
            <span>Two stats are hidden and one visible stat is lying this round.</span>
          </div>
        )}
        {mode === 'challenge' && solved && state?.reveal && (
          <div className="mt-4 border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-slate-300">
            <span className="font-semibold text-rose-300">{columnLabels([state.reveal.liar])[0]}</span> was the
            lie this round: the game showed it as{' '}
            <span className="font-semibold text-rose-200">{state.reveal.shown}</span>, but it is really{' '}
            <span className="font-semibold text-emerald-200">{state.reveal.real}</span>.{' '}
            <span className="font-semibold text-slate-200">{columnLabels(state.reveal.hidden).join(' and ')}</span>{' '}
            {state.reveal.hidden.length === 1 ? 'was' : 'were'} hidden. The board shows every stat truthfully, with
            what the lie had displayed under the {columnLabels([state.reveal.liar])[0]} column.
          </div>
        )}

        {/* column reference — collapsed, so it's discoverable but not pushy */}
        <ColumnGuide />

        {/* guesses */}
        <div className="mt-3">
          <GuessGrid results={results} hidden={hidden} revealLiar={state?.reveal?.liar} />
        </div>

        <footer className="mt-14 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line pt-4 font-mono text-[10px] uppercase tracking-widest text-slate-600">
          <span>{UNITS.length} units · resets 00:00 UTC</span>
          <span className="text-slate-700">·</span>
          <a
            href={DATA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-slate-500 underline decoration-slate-700 underline-offset-2 transition-colors hover:text-accent"
          >
            Unit data &amp; icons from the FAF Unit Database ↗
          </a>
        </footer>
      </div>
    </div>
  );
}

// Both modes are always visible, with the active one filled, so it's obvious
// that the challenge is a separate mode you can switch to.
function ModeSwitch({ mode, onSwitch }: { mode: Mode; onSwitch: (m: Mode) => void }) {
  const option = (m: Mode, label: string, title: string, icon?: JSX.Element) => (
    <button
      onClick={() => mode !== m && onSwitch(m)}
      aria-pressed={mode === m}
      title={title}
      className={`inline-flex items-center gap-2 px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest transition-colors sm:px-4 sm:py-2.5 ${
        mode === m ? 'bg-accent text-slate-950' : 'text-slate-400 hover:bg-surface2 hover:text-slate-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div className="shrink-0 text-right">
      <p className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-slate-500">Mode</p>
      <div className="inline-flex border border-line bg-surface p-1">
        {option('daily', 'Daily', 'The normal daily')}
        {option(
          'challenge',
          'Challenge',
          'The harder daily challenge',
          <Swords className="h-3.5 w-3.5" strokeWidth={2.5} />
        )}
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 ${className}`} />
      {label}
    </span>
  );
}

function WinCard({
  answer,
  guesses,
  now,
  challenge,
  onTryChallenge,
}: {
  answer: Unit;
  guesses: Unit[];
  now: number;
  challenge: boolean;
  onTryChallenge?: () => void;
}) {
  const left = msUntilNextUTCDay(new Date(now));
  const count = guesses.length;
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const label = challenge ? 'Daily Challenge' : 'Daily';
  const shareText = `I solved FAF ${label} #${puzzleNumber()} in ${count} ${count === 1 ? 'try' : 'tries'} — try it yourself: ${location.origin}`;

  async function shareImg(spoilerFree: boolean) {
    setBusy(true);
    setFlash(null);
    try {
      const blob = await buildShareImage(guesses, answer, { spoilerFree, challenge });
      if (!blob) return;
      const name = `${spoilerFree ? '' : 'SPOILER_'}faf-daily${challenge ? '-challenge' : ''}-${puzzleNumber()}.png`;
      const file = new File([blob], name, { type: 'image/png' });
      const nav = navigator as Navigator & {
        canShare?: (d: unknown) => boolean;
        share?: (d: unknown) => Promise<void>;
      };
      // Phones → native share sheet, image only (Discord auto-blurs the SPOILER_ file).
      const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
      if (coarse && nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
        await nav.share({ files: [file] });
        setFlash('Shared');
      } else {
        // Desktop → copy the image to the clipboard.
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          setFlash(
            spoilerFree
              ? 'Image copied — paste it into Discord'
              : 'Image copied — paste, then click “Mark as spoiler”'
          );
        } catch {
          // Some browsers (e.g. Opera GX) block image clipboard writes.
          setFlash('This browser blocked the image copy — use “Copy link” instead');
        }
      }
      setTimeout(() => setFlash(null), 6000);
    } catch {
      /* cancelled or error — ignore */
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareText);
      setFlash('Link copied');
    } catch {
      setFlash('Copy failed — select the text and copy it manually');
    }
    setTimeout(() => setFlash(null), 4000);
  }

  return (
    <div className="border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-4 border-b border-line p-5">
        <UnitIcon unit={answer} size={84} />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-widest text-emerald-400">Identified</p>
          <h2 className="mt-1 truncate text-xl font-semibold text-slate-100 sm:text-2xl">{answer.name}</h2>
          <p className="mt-0.5 truncate font-mono text-xs uppercase tracking-wide text-slate-500">
            {answer.faction} · {answer.tech} · {answer.desc}
          </p>
        </div>
        {onTryChallenge && (
          <div className="w-full border border-accent/60 bg-accent/[0.07] p-4 sm:w-auto sm:max-w-[360px] sm:shrink-0">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-accent">
              Daily done · up next
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">
              Want a challenge? Try the <span className="font-semibold text-slate-100">Daily Challenge</span>: a
              different unit, 2 hidden stats and 1 lie.
            </p>
            <button
              onClick={onTryChallenge}
              className="group mt-3 inline-flex w-full items-center justify-center gap-2.5 bg-accent px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-widest text-slate-950 shadow-[0_0_24px_rgba(244,123,63,0.3)] transition-colors hover:bg-[#ff935c]"
            >
              Play the Daily Challenge
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-xs uppercase tracking-widest text-slate-400">
            Solved in <span className="text-emerald-300">{count}</span> {count === 1 ? 'try' : 'tries'}
          </p>
          <span className="inline-flex items-center gap-2 border border-accent/70 px-3 py-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-accent">
            <Clock className="h-3.5 w-3.5" strokeWidth={2} />
            Next unit {formatCountdown(left)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => shareImg(true)}
            disabled={busy}
            title="Image with just the colored squares — reveals nothing"
            className="inline-flex items-center gap-2 bg-slate-100 px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-widest text-slate-950 transition-colors hover:bg-white disabled:opacity-60"
          >
            <Share2 className="h-4 w-4" strokeWidth={2} />
            {busy ? 'Rendering…' : 'Share (no spoilers)'}
          </button>
          <button
            onClick={() => shareImg(false)}
            disabled={busy}
            title="Image showing your guessed units (answer hidden) — spoilers"
            className="inline-flex items-center gap-2 border border-line px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-widest text-slate-300 transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
          >
            <Share2 className="h-4 w-4" strokeWidth={2} />
            With guesses
          </button>
        </div>
      </div>

      {flash && <p className="px-5 -mt-2 pb-3 font-mono text-[11px] text-emerald-300">{flash}</p>}

      {/* the link / "try it yourself" as copyable text (works in every browser) */}
      <div className="flex items-center gap-3 border-t border-line p-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">{shareText}</code>
        <button
          onClick={copyLink}
          className="inline-flex shrink-0 items-center gap-2 border border-line px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-300 transition-colors hover:border-accent hover:text-accent"
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
          Copy link
        </button>
      </div>
    </div>
  );
}
