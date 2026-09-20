/**
 * DEVELOPMENT ONLY. Street-lock search origin helper tests.
 */
import type { LocateEdgeHit } from '../routing/valhalla';
import {
  SEARCH_ORIGIN_SNAP,
  closestLocateEdge,
  connectorEndpoints,
  identitySearchOrigin,
  originalLocation,
  placementDistanceFromUser,
  searchOriginFromLocateEdges,
  searchOriginFromLocateHit,
  searchOriginFromSnap,
} from './snap-search-origin';

type SelfTest = { name: string; passed: boolean; detail: string };

const GPS = { latitude: 31.227549356302422, longitude: 29.94947010481379 };
const GPS_A = { latitude: 31.22725316530078, longitude: 29.949506749489323 };
const STREET_NODE_A = { latitude: 31.2274, longitude: 29.9495 };
const STREET_NODE_B = { latitude: 31.228, longitude: 29.9495 };
const INTERSECTION = { latitude: 31.227553, longitude: 29.949661 };
const FAR_EDGE = { latitude: 31.23, longitude: 29.96 };

const nearbyEdge: LocateEdgeHit = {
  snapped: { latitude: 31.22745, longitude: 29.94948 },
  wayId: 42,
  distanceMeters: 12,
  shape: [STREET_NODE_A, STREET_NODE_B],
};

const farEdge: LocateEdgeHit = {
  snapped: FAR_EDGE,
  wayId: 99,
  distanceMeters: 400,
  shape: [FAR_EDGE],
};

const success = searchOriginFromLocateHit(GPS, nearbyEdge);
const fallbackNone = searchOriginFromLocateHit(GPS, null);
const fallbackFar = searchOriginFromLocateHit(GPS, farEdge);
const identity = identitySearchOrigin(GPS);
const connector = connectorEndpoints(GPS, searchOriginFromSnap(success), { x: 100, y: 50 });

const tests: SelfTest[] = [
  {
    name: 'successful snap keeps raw GPS and uses a pedestrian node',
    passed:
      success.snapped &&
      success.originalLatitude === GPS.latitude &&
      success.originalLongitude === GPS.longitude &&
      success.snappedLatitude === STREET_NODE_A.latitude &&
      success.snappedLongitude === STREET_NODE_A.longitude &&
      success.wayId === 42 &&
      success.snapDistanceMeters > 0 &&
      success.snapDistanceMeters <= SEARCH_ORIGIN_SNAP.radiusMeters,
    detail: `${success.snappedLatitude},${success.snappedLongitude} d=${success.snapDistanceMeters.toFixed(1)}`,
  },
  {
    name: 'snap fallback when no pedestrian edge is found',
    passed:
      !fallbackNone.snapped &&
      fallbackNone.snappedLatitude === GPS.latitude &&
      fallbackNone.snappedLongitude === GPS.longitude &&
      fallbackNone.fallbackReason === 'no_pedestrian_edge',
    detail: fallbackNone.fallbackReason ?? 'none',
  },
  {
    name: 'snap fallback when the nearest edge is beyond the radius',
    passed:
      !fallbackFar.snapped &&
      fallbackFar.snappedLatitude === GPS.latitude &&
      fallbackFar.fallbackReason === 'beyond_radius' &&
      SEARCH_ORIGIN_SNAP.radiusMeters === 125,
    detail: `radius=${SEARCH_ORIGIN_SNAP.radiusMeters} reason=${fallbackFar.fallbackReason}`,
  },
  {
    name: 'raw vs snapped coordinates are kept separate',
    passed:
      originalLocation(success).latitude === GPS.latitude &&
      searchOriginFromSnap(success).latitude === STREET_NODE_A.latitude &&
      originalLocation(success).latitude !== searchOriginFromSnap(success).latitude,
    detail: `raw=${originalLocation(success).latitude} search=${searchOriginFromSnap(success).latitude}`,
  },
  {
    name: 'connector starts from the raw GPS, not the snapped origin',
    passed:
      connector.from.latitude === GPS.latitude &&
      connector.from.longitude === GPS.longitude &&
      connector.to != null &&
      connector.to.latitude !== GPS.latitude,
    detail: `from=${connector.from.latitude} to=${connector.to?.latitude}`,
  },
  {
    name: 'search uses snapped location for placement distance',
    passed: (() => {
      const snapped = searchOriginFromSnap(success);
      const fromGps = placementDistanceFromUser(GPS, snapped, 565.7, 565.7);
      const fromSearch = placementDistanceFromUser(snapped, snapped, 565.7, 565.7);
      return Math.abs(fromSearch - Math.hypot(565.7, 565.7)) < 3 && Math.abs(fromGps - fromSearch) > 0.5;
    })(),
    detail: `fromGps=${placementDistanceFromUser(GPS, searchOriginFromSnap(success), 565.7, 565.7).toFixed(1)} fromSearch=${placementDistanceFromUser(searchOriginFromSnap(success), searchOriginFromSnap(success), 565.7, 565.7).toFixed(1)}`,
  },
  {
    name: 'closest edge is the nearer pedestrian hit',
    passed: closestLocateEdge([farEdge, nearbyEdge])?.wayId === 42,
    detail: `way=${closestLocateEdge([farEdge, nearbyEdge])?.wayId}`,
  },
  {
    name: 'identity snap does not claim a street lock',
    passed: !identity.snapped && identity.snapDistanceMeters === 0 && identity.fallbackReason === 'identity',
    detail: identity.fallbackReason ?? 'none',
  },
  {
    name: 'nearby GPS samples lock to the same pedestrian node, not the closest-edge far endpoint',
    passed: (() => {
      const closestToA: LocateEdgeHit = {
        snapped: { latitude: 31.227371, longitude: 29.949395 },
        wayId: 157600816,
        distanceMeters: 16.8,
        shape: [INTERSECTION, { latitude: 31.22671, longitude: 29.948431 }],
      };
      const closestToB: LocateEdgeHit = {
        snapped: { latitude: 31.227611, longitude: 29.949412 },
        wayId: 157600134,
        distanceMeters: 8.7,
        shape: [
          { latitude: 31.227031, longitude: 29.948554 },
          { latitude: 31.228127, longitude: 29.950176 },
        ],
      };
      const shared: LocateEdgeHit = {
        snapped: INTERSECTION,
        wayId: 157600816,
        distanceMeters: 18.2,
        shape: [INTERSECTION, { latitude: 31.227995, longitude: 29.950309 }],
      };
      const snapA = searchOriginFromLocateEdges(GPS_A, [closestToA, shared]);
      const snapB = searchOriginFromLocateEdges(GPS, [closestToB, shared]);
      return (
        snapA.snapped &&
        snapB.snapped &&
        snapA.snappedLatitude === INTERSECTION.latitude &&
        snapA.snappedLongitude === INTERSECTION.longitude &&
        snapB.snappedLatitude === INTERSECTION.latitude &&
        snapB.snappedLongitude === INTERSECTION.longitude &&
        snapA.originalLatitude === GPS_A.latitude &&
        snapB.originalLatitude === GPS.latitude
      );
    })(),
    detail: 'shared intersection node',
  },
  {
    name: 'intermediate shape vertices are not used as the search origin',
    passed: (() => {
      const edge: LocateEdgeHit = {
        snapped: { latitude: 31.2274, longitude: 29.94948 },
        wayId: 7,
        distanceMeters: 10,
        shape: [
          INTERSECTION,
          { latitude: 31.227549356302422, longitude: 29.94947010481379 },
          STREET_NODE_B,
        ],
      };
      const snap = searchOriginFromLocateHit(GPS, edge);
      return snap.snappedLatitude === INTERSECTION.latitude && snap.snappedLongitude === INTERSECTION.longitude;
    })(),
    detail: 'endpoints only',
  },
];

for (const test of tests) {
  console.log(`${test.passed ? 'PASS' : 'FAIL'}  ${test.name} — ${test.detail}`);
}
if (tests.some((test) => !test.passed)) {
  process.exitCode = 1;
}
