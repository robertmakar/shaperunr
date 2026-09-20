import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';

import { ensureAutoPauseHydrated, getAutoPauseSetting } from '@/lib/auto-pause-preference';
import { startForegroundPositionWatch, type ForegroundWatch } from '@/lib/foreground-gps';
import type { Coordinate } from '@/lib/geo';
import {
  appendRunSessionGpsFix,
  createRunTrackingSession,
  elapsedRunMilliseconds,
  finishRunTrackingSession,
  pauseRunTrackingSession,
  resumeRunTrackingSession,
  runCoursePhase,
  runSessionDistanceMeters,
  runSessionPath,
  startRunTrackingSession,
  type RunCoursePhase,
  type RunTrackingSession,
} from '@/lib/run-tracking';
import type { LocationFailureReason } from '@/lib/location';

export function useForegroundRun(shapeStart?: Coordinate) {
  const watchRef = useRef<ForegroundWatch | null>(null);
  const requestIdRef = useRef(0);
  const resumePendingRef = useRef(false);
  const mountedRef = useRef(true);
  const sessionRef = useRef<RunTrackingSession>(createRunTrackingSession());

  const [session, setSessionState] = useState<RunTrackingSession>(sessionRef.current);
  const [deniedReason, setDeniedReason] = useState<LocationFailureReason | null>(null);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());

  const stopWatch = useCallback(() => {
    watchRef.current?.remove();
    watchRef.current = null;
  }, []);

  const setSession = useCallback((next: RunTrackingSession) => {
    sessionRef.current = next;
    if (mountedRef.current) {
      setSessionState(next);
    }
  }, []);

  const applyFix = useCallback(
    (fix: Parameters<typeof appendRunSessionGpsFix>[1]) => {
      setSession(appendRunSessionGpsFix(sessionRef.current, fix));
    },
    [setSession],
  );

  const pause = useCallback(() => {
    if (sessionRef.current.status !== 'running') {
      return;
    }
    stopWatch();
    const now = Date.now();
    setClockNowMs(now);
    setSession(pauseRunTrackingSession(sessionRef.current, now));
  }, [setSession, stopWatch]);

  const finish = useCallback(() => {
    if (
      sessionRef.current.status !== 'running' &&
      sessionRef.current.status !== 'paused'
    ) {
      return;
    }
    requestIdRef.current += 1;
    stopWatch();
    const now = Date.now();
    setClockNowMs(now);
    setSession(finishRunTrackingSession(sessionRef.current, now));
  }, [setSession, stopWatch]);

  const start = useCallback(async () => {
    if (
      watchRef.current ||
      sessionRef.current.status === 'requesting' ||
      sessionRef.current.status === 'running'
    ) {
      return;
    }
    const requestId = ++requestIdRef.current;
    setDeniedReason(null);
    setSession(createRunTrackingSession('requesting'));
    setClockNowMs(Date.now());

    const result = await startForegroundPositionWatch({
      onFix: applyFix,
    });

    if (
      !mountedRef.current ||
      requestId !== requestIdRef.current ||
      AppState.currentState !== 'active'
    ) {
      if (result.ok) {
        result.watch.remove();
      }
      if (mountedRef.current && requestId === requestIdRef.current) {
        setSession(createRunTrackingSession());
      }
      return;
    }
    if (!result.ok) {
      setDeniedReason(result.reason);
      setSession(createRunTrackingSession('denied'));
      return;
    }

    watchRef.current = result.watch;
    const now = Date.now();
    setClockNowMs(now);
    setSession(startRunTrackingSession(now));
  }, [applyFix, setSession]);

  const resume = useCallback(async () => {
    if (
      sessionRef.current.status !== 'paused' ||
      watchRef.current ||
      resumePendingRef.current
    ) {
      return;
    }
    resumePendingRef.current = true;
    const requestId = ++requestIdRef.current;
    const result = await startForegroundPositionWatch({
      onFix: applyFix,
    });
    resumePendingRef.current = false;

    if (
      !mountedRef.current ||
      requestId !== requestIdRef.current ||
      sessionRef.current.status !== 'paused' ||
      AppState.currentState !== 'active'
    ) {
      if (result.ok) {
        result.watch.remove();
      }
      return;
    }
    if (!result.ok) {
      setDeniedReason(result.reason);
      setSession({
        ...sessionRef.current,
        status: 'denied',
      });
      return;
    }

    watchRef.current = result.watch;
    const now = Date.now();
    setClockNowMs(now);
    setSession(resumeRunTrackingSession(sessionRef.current, now));
  }, [applyFix, setSession]);

  const retry = useCallback(async () => {
    if (deniedReason === 'restricted') {
      await Linking.openSettings();
      return;
    }
    await start();
  }, [deniedReason, start]);

  useEffect(() => {
    if (session.status !== 'running') {
      return;
    }
    const timer = setInterval(() => {
      setClockNowMs(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [session.status]);

  useEffect(() => {
    ensureAutoPauseHydrated();
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (
        nextState !== 'active' &&
        sessionRef.current.status === 'running' &&
        getAutoPauseSetting() === 'on'
      ) {
        pause();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [pause]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      watchRef.current?.remove();
      watchRef.current = null;
    };
  }, []);

  const path = runSessionPath(session);
  const distanceMeters = runSessionDistanceMeters(session);
  const elapsedMs = elapsedRunMilliseconds(session, clockNowMs);
  const phase: RunCoursePhase = runCoursePhase(session.position, shapeStart);

  return {
    status: session.status,
    deniedReason,
    path,
    pathSegments: session.pathSegments,
    position: session.position,
    elapsedMs,
    distanceMeters,
    phase,
    start,
    pause,
    resume,
    finish,
    retry,
  };
}
