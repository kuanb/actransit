import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

let BUS_LOCATIONS_FETCH_COUNT = 0;
const MAX_MINUTES_AGO = 8;

type Coord = [number, number];

function sqDist(a: Coord, b: Coord): number {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function segmentLength(a: Coord, b: Coord): number {
  return Math.sqrt(sqDist(a, b));
}

/** Cumulative distances along a polyline, starting at 0. */
function cumulativeDistances(coords: Coord[]): number[] {
  const d = [0];
  for (let i = 1; i < coords.length; i++) {
    d.push(d[i - 1] + segmentLength(coords[i - 1], coords[i]));
  }
  return d;
}

/** Project a point onto a polyline; return the distance along the line. */
function projectOnLine(pt: Coord, coords: Coord[], cumDist: number[]): number {
  let bestDist = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 === 0 ? 0 : ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + t * abx, py = a[1] + t * aby;
    const d = sqDist(pt, [px, py]);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cumDist[i] + t * (cumDist[i + 1] - cumDist[i]);
    }
  }
  return bestAlong;
}

/** Extract a substring of a polyline between two distances. */
function lineSubstring(coords: Coord[], cumDist: number[], startD: number, endD: number): Coord[] {
  if (startD > endD) [startD, endD] = [endD, startD];
  const totalLen = cumDist[cumDist.length - 1];
  startD = Math.max(0, startD);
  endD = Math.min(totalLen, endD);
  const result: Coord[] = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const d0 = cumDist[i], d1 = cumDist[i + 1];
    if (d1 < startD) continue;
    if (d0 > endD) break;

    if (d0 <= startD && startD <= d1) {
      const t = d1 === d0 ? 0 : (startD - d0) / (d1 - d0);
      result.push([
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ]);
    }

    if (d0 >= startD && d0 <= endD) {
      if (result.length === 0 || sqDist(result[result.length - 1], coords[i]) > 0) {
        result.push(coords[i]);
      }
    }

    if (d0 <= endD && endD <= d1) {
      const t = d1 === d0 ? 0 : (endD - d0) / (d1 - d0);
      result.push([
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ]);
    }
  }
  return result;
}

/** Snap historical pings to a route geometry, returning the covered substring. */
function snapToRoute(
  pingCoords: Coord[],
  routeCoords: Coord[],
): Coord[] | null {
  if (routeCoords.length < 2 || pingCoords.length < 1) return null;
  const cumDist = cumulativeDistances(routeCoords);
  const projections = pingCoords.map(pt => projectOnLine(pt, routeCoords, cumDist));
  const minD = Math.min(...projections);
  const maxD = Math.max(...projections);
  const sub = lineSubstring(routeCoords, cumDist, minD, maxD);
  return sub.length >= 2 ? sub : null;
}

function convertBusDataToFeatures(busData) {
  return busData.filter(ea => ea.vehicle.trip).map((bus, index) => {
    const lat = bus.vehicle.position.latitude;
    const lng = bus.vehicle.position.longitude;
    const bearing = bus.vehicle.position.bearing;
    const speed = bus.vehicle.position.speed;
    const routeId = bus.vehicle.trip.routeId;
    const tripId = bus.vehicle.trip.tripId;
    const timestamp = bus.vehicle.timestamp;

    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lng, lat]
      },
      properties: {
        bearing: bearing,
        routeId: routeId,
        speed: speed,
        timestamp,
        tripId,
      }
    };
  }).filter(feature => {
    const [lng, lat] = feature.geometry.coordinates;
    const isValid = lng && lat && !isNaN(lng) && !isNaN(lat) &&
      lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
    if (!isValid) {
      console.warn('Filtered out invalid coordinates:', feature.geometry.coordinates);
    }
    return isValid;
  });
}

/** GTFS/JSON feeds often send timestamps as strings */
function parseVehicleUnixTimestamp(t: unknown): number | null {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && t.trim() !== '') {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** e.g. "5 min, 23 secs" for how old position data is */
function formatDataAgeMinutesSeconds(ts: unknown): string | null {
  const unix = parseVehicleUnixTimestamp(ts);
  if (unix === null) return null;
  const diffSec = Math.max(0, Date.now() / 1000 - unix);
  const minutes = Math.floor(diffSec / 60);
  const seconds = Math.floor(diffSec % 60);
  return `${minutes} min, ${seconds} secs`;
}

/** unixSeconds from vehicle feed; shown in Pacific time with age in minutes */
function formatPstWithMinutesOld(unixSeconds: number) {
  const ms = unixSeconds * 1000;
  const date = new Date(ms);
  const pst = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
  const minutesOld = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return `${pst} (${minutesOld} min ago)`;
}

const ACTransitMap = () => {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [busData, setBusData] = useState([]);
  const [busHistoryData, setBusHistoryData] = useState([]);
  const [routeStopPredictions, setRouteStopPredictions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [routeFilter, setRouteFilter] = useState('');
  const [activeStopFilter, setActiveStopFilter] = useState(null);
  const [tripAverageSpeeds, setTripAverageSpeeds] = useState({});
  const tripAverageSpeedsRef = useRef({});
  const popupRef = useRef(null);
  const stopPopupRef = useRef(null);
  const [cacheAgeTick, setCacheAgeTick] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [routeInfo, setRouteInfo] = useState<{ count: number; vintage: string } | null>(null);
  const [routeNames, setRouteNames] = useState<string[]>([]);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [cacheMinimized, setCacheMinimized] = useState(false);
  const cacheAutoMinimized = useRef(false);
  const routeGeometriesRef = useRef<Record<string, Coord[][]>>({});
  const routeFilterRef = useRef('');
  const shouldZoomOnFilterChange = useRef(false);

  // Re-render periodically so "min ago" stays accurate
  useEffect(() => {
    const id = window.setInterval(() => setCacheAgeTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // Auto-minimize cache panel 3s after mount
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!cacheAutoMinimized.current) {
        cacheAutoMinimized.current = true;
        setCacheMinimized(true);
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // Initialize route filter from URL query parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const filterFromUrl = urlParams.get('route');
    if (filterFromUrl) {
      setRouteFilter(filterFromUrl);
    }
  }, []);

  // Update URL when route filter changes
  useEffect(() => {
    const url = new URL(window.location.href);
    if (routeFilter.trim()) {
      url.searchParams.set('route', routeFilter.trim());
    } else {
      url.searchParams.delete('route');
    }
    window.history.replaceState({}, '', url);
  }, [routeFilter]);

  // Log when tripAverageSpeeds state is updated
  useEffect(() => {
    if (Object.keys(tripAverageSpeeds).length > 0) {
      console.log('tripAverageSpeeds state updated:', tripAverageSpeeds);
      tripAverageSpeedsRef.current = tripAverageSpeeds;
    }
  }, [tripAverageSpeeds]);

  // Fetch bus locations
  const fetchBusLocations = async () => {
    try {
      setLoading(true);
      const response = await fetch(
        'https://storage.googleapis.com/transit-203605-actransit-cache/latest.json',
        { cache: 'no-store' }
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log('Bus data received:', data);
      BUS_LOCATIONS_FETCH_COUNT += 1;
      setBusData(data);

      setLoading(true);
      const historyResponse = await fetch(
        'https://storage.googleapis.com/transit-203605-actransit-cache/history.json',
        { cache: 'no-store' }
      );
      if (!historyResponse.ok) {
        throw new Error(`HTTP error! status: ${historyResponse.status}`);
      }
      const historyData = await historyResponse.json();
      console.log('Bus history data received:', historyData);
      console.log('History data type:', typeof historyData);
      console.log('History data length:', historyData ? historyData.length : 'null/undefined');
      setBusHistoryData(historyData);

      // Calculate average speeds for all trips
      const averageSpeeds = calculateAllTripAverageSpeeds(historyData);
      console.log('averageSpeeds:', averageSpeeds);
      console.log('averageSpeeds type:', typeof averageSpeeds);
      console.log('averageSpeeds keys:', Object.keys(averageSpeeds));
      console.log('averageSpeeds length:', Object.keys(averageSpeeds).length);
      setTripAverageSpeeds(averageSpeeds);
      // Note: tripAverageSpeeds will be empty here due to React's async state updates

      // Fetch route stop predictions
      await fetchRouteStopPredictions();

      setError(null);
    } catch (err) {
      setError(`Failed to set bus locations: ${err.message}`);
      console.error('Error fetching bus data:', err);
    } finally {
      setLoading(false);
      setRefreshKey((k) => k + 1);
    }
  };

  // Fetch route stop predictions
  const fetchRouteStopPredictions = async () => {
    try {
      const response = await fetch(
        'https://storage.googleapis.com/transit-203605-actransit-cache/route_stops.json',
        { cache: 'no-store' }
      );
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log('Route stop predictions received:', data);
      setRouteStopPredictions(data);
    } catch (err) {
      console.error('Error fetching route stop predictions:', err);
    }
  };

  // Initialize map
  useEffect(() => {
    if (!mapContainer.current) return;

    // Load MapLibre CSS if not already loaded
    if (!document.querySelector('link[href*="maplibre-gl"]')) {
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
      document.head.appendChild(cssLink);
    }

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://api.maptiler.com/maps/streets-v2-light/style.json?key=smyKrds9C01IazzvU1Tr',
      center: [-122.2681, 37.8044],
      zoom: 10,
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
      logoPosition: 'bottom-left',
      attributionControl: false,
    });
    map.current.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.current.on('load', () => {
      console.log('Map loaded');

      // Add source for bus locations
      map.current.addSource('buses', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      // Add source for bus locations
      map.current.addSource('busesHistory', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      map.current.addSource('busesHistoryLines', {
        type: 'geojson',
        lineMetrics: true,
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      // Add source for route geometries (lazy-loaded)
      map.current.addSource('routes', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });

      map.current.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': ['concat', '#', ['get', 'route_color']],
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            8, 1,
            12, 1.5,
            16, 3,
          ],
          'line-opacity': 0.55,
        },
      });

      // Add source for stops
      map.current.addSource('stops', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      // Add layer for stops
      map.current.addLayer({
        id: 'stops-circles',
        type: 'circle',
        source: 'stops',
        minzoom: 13,
        paint: {
          'circle-radius': 4,
          'circle-color': '#0066cc',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.45
        }
      });

      // Shadow halo beneath bus icons
      map.current.addLayer({
        id: 'bus-shadows',
        type: 'circle',
        source: 'buses',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8, 3,
            12, 6,
            15, 10,
            18, 14,
          ],
          'circle-color': '#000',
          'circle-opacity': 0.25,
          'circle-blur': 0.8,
        },
      });

      map.current.addLayer({
        id: 'bus-arrows',
        type: 'symbol',
        source: 'buses',
        layout: {
          'icon-image': 'bus',
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 0.15,
            10, 0.3,
            12, 0.5,
            15, 0.85,
            18, 1.2,
            20, 1.5,
          ],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        },
        paint: {
          'icon-color': '#ff4444'
        }
      });

      map.current.addLayer({
        id: 'bus-history',
        type: 'circle',
        source: 'busesHistory',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            8, 2,
            12, 3,
            15, 5,
            18, 7,
          ],
          'circle-color': '#ff4444',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1,
          'circle-opacity': [
            'case',
            ['==', ['get', 'show-history'], true],
            0.7,
            0
          ],
          'circle-stroke-opacity': [
            'case',
            ['==', ['get', 'show-history'], true],
            0.5,
            0
          ],
        },
      });

      // Add layer for bus history lines
      map.current.addLayer({
        id: 'bus-history-lines',
        type: 'line',
        source: 'busesHistoryLines',
        layout: {
          'line-join': 'round',
          'line-cap': 'round'
        },
        paint: {
          'line-gradient': [
            'interpolate', ['linear'], ['line-progress'],
            0, 'rgba(255, 68, 68, 0.15)',
            0.7, 'rgba(255, 68, 68, 0.5)',
            1, 'rgba(255, 68, 68, 0.85)',
          ],
          'line-width': 8,
          'line-opacity': [
            'case',
            ['==', ['get', 'show-history'], true],
            1,
            0
          ]
        }
      });

      // Create arrow icon
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 20;
      canvas.height = 70;
      
      // Draw simple bus shape - long rectangle with front window
      ctx.fillStyle = '#ff4444';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      
      // Main bus body (long vertical rectangle)
      ctx.beginPath();
      ctx.fillRect(2, 5, 16, 60);
      ctx.strokeRect(2, 5, 16, 60);
      
      // Front window (rectangle at front to show direction)
      ctx.fillStyle = '#87CEEB';
      ctx.beginPath();
      ctx.fillRect(3, 5, 14, 8);
      ctx.strokeRect(3, 5, 14, 8);

      map.current.addImage('bus', {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data
      });

      // Initial data fetch
      fetchBusLocations();

      // Lazy-load route geometries after initial render
      fetch(`${import.meta.env.BASE_URL}latest_routes.geojson`)
        .then(r => r.json())
        .then(geojson => {
          if (map.current?.getSource('routes')) {
            (map.current.getSource('routes') as maplibregl.GeoJSONSource).setData(geojson);
          }
          setRouteInfo({
            count: geojson.features?.length ?? 0,
            vintage: geojson.gtfs_vintage ?? 'unknown',
          });
          const names: string[] = Array.from(new Set(
            (geojson.features ?? []).map((f: any) => f.properties?.route_short_name).filter(Boolean)
          ));
          setRouteNames(names);

          const geoMap: Record<string, Coord[][]> = {};
          for (const feat of geojson.features ?? []) {
            const rid = feat.properties?.route_short_name || feat.properties?.route_id;
            if (rid && feat.geometry?.coordinates) {
              if (!geoMap[rid]) geoMap[rid] = [];
              geoMap[rid].push(feat.geometry.coordinates);
            }
          }
          routeGeometriesRef.current = geoMap;
        })
        .catch(err => console.warn('Failed to load route geometries:', err));
    });

    return () => {
      if (map.current) {
        map.current.remove();
      }
    };
  }, []);

  // Update map with bus data
  useEffect(() => {
    if (!map.current || !busData.length) return;

    console.log('Processing bus data:', busData.length, 'buses');

    let features = convertBusDataToFeatures(busData);

    // Filter by route ID if filter is set
    if (routeFilter.trim()) {
      features = features.filter(feature => 
        feature.properties.routeId && 
        feature.properties.routeId.toLowerCase() === routeFilter.trim().toLowerCase()
      );
      console.log('Filtered to', features.length, 'buses matching route filter:', routeFilter);
    }

    // Filter by active stop filter
    if (activeStopFilter && activeStopFilter.routeNames.length > 0) {
      features = features.filter(feature => 
        feature.properties.routeId && 
        activeStopFilter.routeNames.includes(feature.properties.routeId)
      );
      console.log('Filtered to', features.length, 'buses matching stop filter routes:', activeStopFilter.routeNames);
    }

    console.log('Valid features:', features.length);

    if (map.current.getSource('buses')) {
      map.current.getSource('buses').setData({
        type: 'FeatureCollection',
        features
      });
      console.log('Updated map with features');
    }

    const shouldZoom = BUS_LOCATIONS_FETCH_COUNT === 1 || shouldZoomOnFilterChange.current;
    shouldZoomOnFilterChange.current = false;

    if (features.length > 0 && shouldZoom) {
      const coordinates = features.map(f => f.geometry.coordinates);
      const bounds = coordinates.reduce((bounds, coord) => {
        return bounds.extend(coord);
      }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

      map.current.fitBounds(bounds, { padding: 50, maxZoom: 16 });
    }
  }, [busData, routeFilter, activeStopFilter]);

  // Calculate filtered bus count
  const filteredBusCount = React.useMemo(() => {
    if (!routeFilter.trim()) return busData.length;
    
    const features = convertBusDataToFeatures(busData);
    return features.filter(feature => 
      feature.properties.routeId && 
      feature.properties.routeId.toLowerCase() === routeFilter.trim().toLowerCase()
    ).length;
  }, [busData, routeFilter]);

  const vehicleTimestampBounds = React.useMemo(() => {
    if (!Array.isArray(busData) || busData.length === 0) return null;
    const timestamps: number[] = [];
    for (const row of busData) {
      const t = parseVehicleUnixTimestamp(row?.vehicle?.timestamp);
      if (t !== null) timestamps.push(t);
    }
    if (timestamps.length === 0) return null;
    return { min: Math.min(...timestamps), max: Math.max(...timestamps) };
  }, [busData]);

  const vehicleTimestampDisplay = React.useMemo(() => {
    if (!vehicleTimestampBounds) return null;
    return {
      min: formatPstWithMinutesOld(vehicleTimestampBounds.min),
      max: formatPstWithMinutesOld(vehicleTimestampBounds.max),
      newestMinutesOld: Math.max(0, Math.round((Date.now() - vehicleTimestampBounds.max * 1000) / 60000)),
    };
  }, [vehicleTimestampBounds, cacheAgeTick]);

  // Calculate historical average MPH for a trip
  const calculateHistoricalAverageMPH = (tripId) => {
    console.log('Calculating historical average MPH for tripId:', tripId);
    console.log('busHistoryData:', busHistoryData);
    console.log('busHistoryData type:', typeof busHistoryData);
    console.log('busHistoryData is array:', Array.isArray(busHistoryData));
    console.log('busHistoryData length:', busHistoryData ? busHistoryData.length : 'null/undefined');
    
    if (!busHistoryData || !busHistoryData.length) {
      console.log('busHistoryData is empty or null');
      return null;
    }
    
    const speeds = [];
    busHistoryData.forEach((historyEntry, index) => {
      console.log(`History entry ${index}:`, historyEntry);
      console.log(`History entry ${index} type:`, typeof historyEntry);
      console.log(`History entry ${index} is array:`, Array.isArray(historyEntry));
      
      if (Array.isArray(historyEntry)) {
        historyEntry.forEach(bus => {
          if (bus.vehicle?.trip?.tripId === tripId && bus.vehicle?.position?.speed) {
            speeds.push(bus.vehicle.position.speed);
          }
        });
      }
    });
    
    console.log('Collected speeds:', speeds);
    
    if (speeds.length === 0) {
      console.log('No speeds found for tripId:', tripId);
      return null;
    }
    
    const averageSpeed = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
    const roundedAverage = Math.round(averageSpeed);
    console.log('Average speed:', roundedAverage);
    return roundedAverage;
  };

  // Calculate average speeds for all trips during data ingestion
  const calculateAllTripAverageSpeeds = (historyData) => {
    console.log('calculateAllTripAverageSpeeds called with historyData length:', historyData ? historyData.length : 'null');
    
    if (!historyData || !historyData.length) {
      console.log('historyData is empty or null, returning empty object');
      return {};
    }
    
    const tripSpeeds = {};
    let totalBusesProcessed = 0;
    let totalSpeedsFound = 0;
    
    historyData.forEach((historyEntry, index) => {
      if (Array.isArray(historyEntry)) {
        historyEntry.forEach((bus, busIndex) => {
          totalBusesProcessed++;
          const tripId = bus.vehicle?.trip?.tripId;
          const speed = bus.vehicle?.position?.speed;
          
          if (tripId && speed !== undefined) {
            if (!tripSpeeds[tripId]) {
              tripSpeeds[tripId] = [];
            }
            tripSpeeds[tripId].push(Math.round(speed, 2));
            totalSpeedsFound++;
          }
        });
      }
    });
    
    console.log('Total buses processed:', totalBusesProcessed);
    console.log('Total speeds found:', totalSpeedsFound);
    console.log('Unique trip IDs found:', Object.keys(tripSpeeds).length);
    
    // Calculate averages
    const averageSpeeds = {};
    Object.keys(tripSpeeds).forEach(tripId => {
      const speeds = tripSpeeds[tripId];
      const average = Math.round(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length);
      averageSpeeds[tripId] = average;
    });
    
    console.log('Calculated average speeds for', Object.keys(averageSpeeds).length, 'trips');
    return averageSpeeds;
  };

  // Extract unique stops from route stop predictions
  const uniqueStops = React.useMemo(() => {
    if (!routeStopPredictions.length) return [];
    
    const stopMap = new Map();
    
    routeStopPredictions.forEach(route => {
      if (route.processedStops && route.processedStops['bustime-response'] && route.processedStops['bustime-response'].stops) {
        route.processedStops['bustime-response'].stops.forEach(stop => {
          if (stop.stpid && stop.lat && stop.lon) {
            if (!stopMap.has(stop.stpid)) {
              stopMap.set(stop.stpid, {
                stpid: stop.stpid,
                stpnm: stop.stpnm,
                lat: stop.lat,
                lon: stop.lon,
                geoid: stop.geoid,
                routeNames: []
              });
            }
            // Add route name to the stop's route list if not already present
            const stopData = stopMap.get(stop.stpid);
            if (!stopData.routeNames.includes(route.routeName)) {
              stopData.routeNames.push(route.routeName);
            }
          }
        });
      }
    });
    
    return Array.from(stopMap.values());
  }, [routeStopPredictions]);

  // Update map with bus history data
  useEffect(() => {
    if (!map.current || !busHistoryData.length) return;

    console.log('Processing bus history data:', busHistoryData.length, 'bus history caches');

    const nestedFeatures = busHistoryData.map(ea => convertBusDataToFeatures(ea));
    const features = nestedFeatures.flat(); // Flatten the nested array

    // Filter out features older than 8 minutes
    const currentTime = Date.now() / 1000;
    const maxMinutesAgo = currentTime - (MAX_MINUTES_AGO * 60);
    const recentFeatures = features.filter(feature => {
      const timestamp = feature.properties.timestamp;
      return timestamp && timestamp > maxMinutesAgo;
    });

    // Add show-history property (initially false for all)
    const featuresWithHistoryFlag = recentFeatures.map(feature => ({
      ...feature,
      properties: {
        ...feature.properties,
        'show-history': false
      }
    }));

    // Create line features connecting historical points by tripId
    const tripGroups = {};
    recentFeatures.forEach(feature => {
      const tripId = feature.properties.tripId;
      if (!tripGroups[tripId]) {
        tripGroups[tripId] = [];
      }
      tripGroups[tripId].push(feature);
    });

    // Get current bus locations to add as final points
    const currentBusFeatures = convertBusDataToFeatures(busData);
    const currentBusMap = {};
    currentBusFeatures.forEach(feature => {
      currentBusMap[feature.properties.tripId] = feature;
    });

    const lineFeatures = Object.values(tripGroups)
      .filter(points => points.length > 1)
      .map(points => {
        const sortedPoints = points.sort((a, b) => a.properties.timestamp - b.properties.timestamp);
        const tripId = sortedPoints[0].properties.tripId;
        const routeId = sortedPoints[0].properties.routeId;

        let allCoordinates: Coord[] = sortedPoints.map(point => point.geometry.coordinates);
        if (currentBusMap[tripId]) {
          allCoordinates.push(currentBusMap[tripId].geometry.coordinates);
        }

        const routeLines = routeGeometriesRef.current[routeId] ?? [];
        let snapped: Coord[] | null = null;
        if (routeLines.length > 0) {
          let bestFit: Coord[] | null = null;
          let bestScore = Infinity;
          for (const rl of routeLines) {
            const candidate = snapToRoute(allCoordinates, rl);
            if (!candidate) continue;
            const cumDist = cumulativeDistances(rl);
            let totalDist = 0;
            for (const pt of allCoordinates) {
              const along = projectOnLine(pt, rl, cumDist);
              const idx = cumDist.findIndex(d => d >= along);
              const i = Math.max(0, idx - 1);
              const t = cumDist[i + 1] === cumDist[i] ? 0 : (along - cumDist[i]) / (cumDist[i + 1] - cumDist[i]);
              const px = rl[i][0] + t * (rl[i + 1][0] - rl[i][0]);
              const py = rl[i][1] + t * (rl[i + 1][1] - rl[i][1]);
              totalDist += sqDist(pt, [px, py]);
            }
            if (totalDist < bestScore) {
              bestScore = totalDist;
              bestFit = candidate;
            }
          }
          snapped = bestFit;
        }

        return {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: snapped || allCoordinates,
          },
          properties: {
            tripId: tripId,
            routeId: routeId,
            'show-history': false
          }
        };
      });

    console.log('Valid features:', featuresWithHistoryFlag.length);
    console.log('Line features:', lineFeatures.length);

    if (map.current.getSource('busesHistory')) {
      map.current.getSource('busesHistory').setData({
        type: 'FeatureCollection',
        features: featuresWithHistoryFlag
      });
      console.log('Updated map with features');
    }

    if (map.current.getSource('busesHistoryLines')) {
      map.current.getSource('busesHistoryLines').setData({
        type: 'FeatureCollection',
        features: lineFeatures
      });
      console.log('Updated map with line features');
    }

    // Fit map to show all buses if we have valid coordinates
    if (featuresWithHistoryFlag.length > 0) {
      const coordinates = featuresWithHistoryFlag.map(f => f.geometry.coordinates);
      const bounds = coordinates.reduce((bounds, coord) => {
        return bounds.extend(coord);
      }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

      if (BUS_LOCATIONS_FETCH_COUNT === 1) map.current.fitBounds(bounds, { padding: 50 });
      console.log('Fitted bounds to show all buses');
    }
  }, [busHistoryData, busData]); // Changed dependency from busData to busHistoryData

  // Update map with stops data
  useEffect(() => {
    if (!map.current || !uniqueStops.length) return;

    console.log('Processing stops data:', uniqueStops.length, 'unique stops');

    let stopFeatures = uniqueStops.map(stop => ({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [stop.lon, stop.lat]
      },
      properties: {
        stpid: stop.stpid,
        stpnm: stop.stpnm,
        geoid: stop.geoid,
        routeNames: stop.routeNames
      }
    }));

    // Filter stops by active stop filter
    if (activeStopFilter && activeStopFilter.routeNames.length > 0) {
      stopFeatures = stopFeatures.filter(feature => {
        const stopRouteNames = feature.properties.routeNames || [];
        return stopRouteNames.some(routeName => 
          activeStopFilter.routeNames.includes(routeName)
        );
      });
      console.log('Filtered to', stopFeatures.length, 'stops matching stop filter routes:', activeStopFilter.routeNames);
    }

    // Filter stops by route text filter
    if (routeFilter.trim()) {
      stopFeatures = stopFeatures.filter(feature => {
        const stopRouteNames = feature.properties.routeNames || [];
        return stopRouteNames.some(routeName => 
          routeName.toLowerCase() === routeFilter.trim().toLowerCase()
        );
      });
      console.log('Filtered to', stopFeatures.length, 'stops matching route text filter:', routeFilter);
    }

    if (map.current.getSource('stops')) {
      map.current.getSource('stops').setData({
        type: 'FeatureCollection',
        features: stopFeatures
      });
      console.log('Updated map with stop features');
    }
  }, [uniqueStops, activeStopFilter, routeFilter]);

  // Filter route lines to match the active route filter
  useEffect(() => {
    routeFilterRef.current = routeFilter;
    if (!map.current?.getLayer('route-lines')) return;

    if (routeFilter.trim()) {
      map.current.setFilter('route-lines', ['==', ['downcase', ['get', 'route_short_name']], routeFilter.trim().toLowerCase()]);
      map.current.setPaintProperty('route-lines', 'line-opacity', 0.8);
    } else if (activeStopFilter && (activeStopFilter as any).routeNames?.length > 0) {
      map.current.setFilter('route-lines', [
        'in',
        ['get', 'route_short_name'],
        ['literal', (activeStopFilter as any).routeNames],
      ]);
      map.current.setPaintProperty('route-lines', 'line-opacity', 0.7);
    } else {
      map.current.setFilter('route-lines', null);
      map.current.setPaintProperty('route-lines', 'line-opacity', 0.55);
    }
  }, [routeFilter, activeStopFilter]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchBusLocations, 30000);
    return () => clearInterval(interval);
  }, []);

  // Add click handler for bus details
  useEffect(() => {
    if (!map.current) return;

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      // maxWidth: '300px'
    });

    const stopPopup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      // maxWidth: '300px'
    });

    const focusRouteLines = (routeId: string | null) => {
      if (!map.current?.getLayer('route-lines')) return;
      if (routeId) {
        map.current.setFilter('route-lines', ['==', ['get', 'route_short_name'], routeId]);
        map.current.setPaintProperty('route-lines', 'line-opacity', 0.25);
      } else if (routeFilterRef.current.trim()) {
        map.current.setFilter('route-lines', ['==', ['downcase', ['get', 'route_short_name']], routeFilterRef.current.trim().toLowerCase()]);
        map.current.setPaintProperty('route-lines', 'line-opacity', 0.8);
      } else {
        map.current.setFilter('route-lines', null);
        map.current.setPaintProperty('route-lines', 'line-opacity', 0.55);
      }
    };

    const handleClick = (e) => {
      const features = map.current.queryRenderedFeatures(e.point, {
        layers: ['bus-arrows']
      });

      if (features.length > 0) {
        const feature = features[0];
        const { routeId, bearing, tripId, speed, timestamp } = feature.properties;
        const dataAge = formatDataAgeMinutesSeconds(timestamp);

        focusRouteLines(routeId);

        const historySource = map.current.getSource('busesHistory');
        if (historySource) {
          const currentData = historySource._data;
          const updatedFeatures = currentData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': f.properties.tripId === tripId
            }
          }));
          
          historySource.setData({
            type: 'FeatureCollection',
            features: updatedFeatures
          });
        }

        // Show history lines for matching trip IDs
        const historyLinesSource = map.current.getSource('busesHistoryLines');
        if (historyLinesSource) {
          const currentLineData = historyLinesSource._data;
          const updatedLineFeatures = currentLineData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': f.properties.tripId === tripId
            }
          }));
          
          historyLinesSource.setData({
            type: 'FeatureCollection',
            features: updatedLineFeatures
          });
        }

        const historicalAvgMPH = tripAverageSpeedsRef.current[tripId] || null;
        const htmlString = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1a1a1a; line-height: 1.5">
            <div style="font-weight: 600; font-size: 15px; margin-bottom: 4px">Route ${routeId}</div>
            <div style="color: #555">Trip ${tripId}</div>
            <div style="display: flex; gap: 12px; margin-top: 4px">
              <span>${Math.round(bearing)}° bearing</span>
              <span>${Math.round(speed)} mph</span>
            </div>
            ${historicalAvgMPH ? `<div style="color: #555; margin-top: 2px">Avg ${historicalAvgMPH} mph</div>` : ''}
            ${dataAge !== null ? `<div style="color: #888; font-size: 11px; margin-top: 4px">${dataAge} ago</div>` : ''}
          </div>`

        if (stopPopupRef.current) { stopPopup.remove(); stopPopupRef.current = null; }
        setActiveStopFilter(null);

        popupRef.current = popup
          .setLngLat(feature.geometry.coordinates)
          .setHTML(htmlString)
          .addTo(map.current);
      } else {
        popup.remove();
        popupRef.current = null;
        focusRouteLines(null);

        const historySource = map.current.getSource('busesHistory');
        if (historySource) {
          const currentData = historySource._data;
          const updatedFeatures = currentData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': false
            }
          }));
          
          historySource.setData({
            type: 'FeatureCollection',
            features: updatedFeatures
          });
        }

        // Hide all history lines when clicking elsewhere
        const historyLinesSource = map.current.getSource('busesHistoryLines');
        if (historyLinesSource) {
          const currentLineData = historyLinesSource._data;
          const updatedLineFeatures = currentLineData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': false
            }
          }));
          
          historyLinesSource.setData({
            type: 'FeatureCollection',
            features: updatedLineFeatures
          });
        }
      }
    };

    const handleMouseEnter = (e) => {
      const features = map.current.queryRenderedFeatures(e.point, {
        layers: ['bus-arrows']
      });

      if (features.length > 0) {
        const feature = features[0];
        const { tripId, routeId } = feature.properties;

        focusRouteLines(routeId);

        const historySource = map.current.getSource('busesHistory');
        if (historySource) {
          const currentData = historySource._data;
          const updatedFeatures = currentData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': f.properties.tripId === tripId
            }
          }));
          
          historySource.setData({
            type: 'FeatureCollection',
            features: updatedFeatures
          });
        }

        // Show history lines for matching trip IDs on hover
        const historyLinesSource = map.current.getSource('busesHistoryLines');
        if (historyLinesSource) {
          const currentLineData = historyLinesSource._data;
          const updatedLineFeatures = currentLineData.features.map(f => ({
            ...f,
            properties: {
              ...f.properties,
              'show-history': f.properties.tripId === tripId
            }
          }));
          
          historyLinesSource.setData({
            type: 'FeatureCollection',
            features: updatedLineFeatures
          });
        }
      }
    };

    const handleMouseLeave = () => {
      focusRouteLines(null);

      const historySource = map.current.getSource('busesHistory');
      if (historySource) {
        const currentData = historySource._data;
        const updatedFeatures = currentData.features.map(f => ({
          ...f,
          properties: {
            ...f.properties,
            'show-history': false
          }
        }));

        historySource.setData({
          type: 'FeatureCollection',
          features: updatedFeatures
        });
      }

      // Hide history for busesHistoryLines
      const historyLinesSource = map.current.getSource('busesHistoryLines');
      if (historyLinesSource) {
        const currentLineData = historyLinesSource._data;
        const updatedLineFeatures = currentLineData.features.map(f => ({
          ...f,
          properties: {
            ...f.properties,
            'show-history': false
          }
        }));

        historyLinesSource.setData({
          type: 'FeatureCollection',
          features: updatedLineFeatures
        });
      }
    };

    map.current.on('click', 'bus-arrows', handleClick);
    map.current.on('mouseenter', 'bus-arrows', handleMouseEnter);
    map.current.on('mouseleave', 'bus-arrows', handleMouseLeave);
    map.current.on('mouseenter', 'bus-arrows', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });

    // Add click handler for stops
    const handleStopClick = (e) => {
      const features = map.current.queryRenderedFeatures(e.point, {
        layers: ['stops-circles']
      });

      if (features.length > 0) {
        const feature = features[0];
        const { stpid, stpnm, routeNames } = feature.properties;
        console.log('Route names:', routeNames);

        // Set active stop filter
        setActiveStopFilter({
          stpid,
          routeNames: routeNames || []
        });

        const htmlString = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1a1a1a; line-height: 1.5">
            <div style="font-weight: 600; font-size: 15px; margin-bottom: 2px">${stpnm || `Stop ${stpid}`}</div>
            ${stpnm ? `<div style="color: #888; font-size: 11px">ID ${stpid}</div>` : ''}
            <div style="margin-top: 4px; color: #555">Routes: ${routeNames ? JSON.parse(routeNames).join(', ') : 'None'}</div>
          </div>`

        if (popupRef.current) { popup.remove(); popupRef.current = null; }

        stopPopupRef.current = stopPopup
          .setLngLat(feature.geometry.coordinates)
          .setHTML(htmlString)
          .addTo(map.current);
      } else {
        if (stopPopupRef.current) {
          stopPopupRef.current.remove();
          stopPopupRef.current = null;
        }
        setActiveStopFilter(null);
      }
    };

    map.current.on('click', 'stops-circles', handleStopClick);
    map.current.on('mouseenter', 'stops-circles', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });

    const routePopup = new maplibregl.Popup({ closeButton: true, closeOnClick: true });

    const handleRouteLineClick = (e) => {
      if (!e.features?.length) return;
      const hitBus = map.current.queryRenderedFeatures(e.point, { layers: ['bus-arrows'] });
      const hitStop = map.current.queryRenderedFeatures(e.point, { layers: ['stops-circles'] });
      if (hitBus.length > 0 || hitStop.length > 0) return;
      const feat = e.features[0];
      const props = feat.properties || {};
      const rows = [
        ['Route', props.route_short_name || props.route_id],
        ['Name', props.route_long_name],
        ['Route ID', props.route_id],
        ['Direction', props.direction_id ?? 'n/a'],
        ['Type', props.route_type],
        ['Agency', props.agency_id],
        ['Color', props.route_color ? `#${props.route_color}` : ''],
      ].filter(([, v]) => v !== undefined && v !== '');

      const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1a1a1a; line-height: 1.6">
          <div style="font-weight: 600; font-size: 15px; margin-bottom: 6px">Route ${props.route_short_name || props.route_id}</div>
          ${rows.map(([k, v]) => `<div><span style="color: #888">${k}:</span> ${v}</div>`).join('')}
        </div>`;

      routePopup.setLngLat(e.lngLat).setHTML(html).addTo(map.current);
    };

    map.current.on('click', 'route-lines', handleRouteLineClick);
    map.current.on('mouseenter', 'route-lines', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });
    map.current.on('mouseleave', 'route-lines', () => {
      map.current.getCanvas().style.cursor = '';
    });

    return () => {
      if (map.current) {
        map.current.off('click', 'bus-arrows', handleClick);
        map.current.off('mouseenter', 'bus-arrows', handleMouseEnter);
        map.current.off('mouseleave', 'bus-arrows', handleMouseLeave);
        map.current.off('click', 'stops-circles', handleStopClick);
        map.current.off('click', 'route-lines', handleRouteLineClick);
      }
    };
  }, []);

  const panelFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  const panelBase: React.CSSProperties = {
    position: 'absolute',
    background: 'rgba(255, 255, 255, 0.88)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: '10px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
    fontFamily: panelFont,
    fontSize: '13px',
    color: '#1a1a1a',
    zIndex: 1000,
  };

  return (
    <div style={{ width: '100%', height: '100dvh', position: 'relative' }}>
      {/* Refresh countdown bar */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '6px',
        zIndex: 1001,
        background: 'rgba(0, 0, 0, 0.08)',
        boxShadow: '0 1px 6px rgba(22, 163, 74, 0.45)',
      }}>
        <div
          key={refreshKey}
          style={{
            height: '100%',
            background: 'linear-gradient(90deg, #16a34a, #22d3ee)',
            boxShadow: '0 0 8px rgba(22, 163, 74, 0.6)',
            animation: 'countdown 30s linear forwards',
          }}
        />
      </div>

      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Control panel */}
      <div style={{ ...panelBase, top: 'max(16px, env(safe-area-inset-top, 0px))', left: 'max(16px, env(safe-area-inset-left, 0px))', padding: '16px', maxWidth: 'min(280px, calc(100vw - 32px))', boxSizing: 'border-box' }}>
        <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '12px' }}>
          AC Transit Live
        </div>

        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#666', fontSize: '12px' }}>
            <div style={{
              width: '14px',
              height: '14px',
              border: '2px solid #007cba',
              borderTop: '2px solid transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              flexShrink: 0,
            }} />
            Loading...
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 10px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '6px',
            color: '#b91c1c',
            fontSize: '12px',
            marginBottom: '8px',
          }}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <div style={{ marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{
                background: '#16a34a',
                color: 'white',
                padding: '1px 7px',
                borderRadius: '10px',
                fontSize: '12px',
                fontWeight: 600,
              }}>
                {filteredBusCount}
              </span>
              <span style={{ color: '#444', fontSize: '13px' }}>buses tracked</span>
            </div>
            {routeFilter.trim() && (
              <div style={{ color: '#888', fontSize: '11px', marginTop: '2px' }}>
                {filteredBusCount} of {busData.length} total
              </div>
            )}
            <div style={{ color: '#999', fontSize: '11px', marginTop: '4px' }}>
              Updates every 30 s
            </div>
          </div>
        )}

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: '#555', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Route filter
          </label>
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={routeFilter}
              onChange={(e) => { shouldZoomOnFilterChange.current = true; setRouteFilter(e.target.value); }}
              placeholder="e.g. 88, 1T, P"
              style={{
                flex: 1,
                minWidth: 0,
                padding: '7px 10px',
                border: '1px solid #d4d4d4',
                borderRadius: '6px',
                fontSize: '13px',
                boxSizing: 'border-box',
                outline: 'none',
                fontFamily: panelFont,
              }}
            />
            <button
              onClick={() => setShowRoutePicker(true)}
              style={{
                padding: '7px 10px',
                background: '#f5f5f5',
                color: '#444',
                border: '1px solid #d4d4d4',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                fontFamily: panelFont,
                whiteSpace: 'nowrap',
              }}
            >
              Browse
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={fetchBusLocations}
            disabled={loading}
            style={{
              flex: 1,
              padding: '8px 0',
              background: loading ? '#e5e5e5' : '#0369a1',
              color: loading ? '#999' : 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: panelFont,
            }}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => {
              setRouteFilter('');
              setActiveStopFilter(null);
              if (popupRef.current) { popupRef.current.remove(); popupRef.current = null; }
              if (stopPopupRef.current) { stopPopupRef.current.remove(); stopPopupRef.current = null; }
            }}
            style={{
              flex: 1,
              padding: '8px 0',
              background: '#f5f5f5',
              color: '#444',
              border: '1px solid #d4d4d4',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              fontFamily: panelFont,
            }}
          >
            Show all
          </button>
        </div>

        <a
          href="https://kuanbutts.com/actransit_perf_v2/"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block',
            marginTop: '10px',
            padding: '8px 10px',
            background: '#fafafa',
            color: '#1a1a1a',
            border: '1px solid #d4d4d4',
            borderRadius: '6px',
            fontSize: '12px',
            fontWeight: 600,
            fontFamily: panelFont,
            textAlign: 'center',
            textDecoration: 'none',
          }}
        >
          Performance Dashboard &rarr;
        </a>
      </div>

      {/* Cache age panel */}
      <div style={{
        ...panelBase,
        bottom: 'max(16px, env(safe-area-inset-bottom, 0px))',
        right: 'max(16px, env(safe-area-inset-right, 0px))',
        padding: '12px 14px',
        maxWidth: 'min(320px, calc(100vw - 32px))',
        maxHeight: 'calc(100dvh - 32px)',
        boxSizing: 'border-box',
        fontSize: '12px',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: '12px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {cacheMinimized
              ? (vehicleTimestampDisplay
                ? `Data is ${vehicleTimestampDisplay.newestMinutesOld} min old`
                : 'Loading...')
              : 'Vehicle cache'}
          </div>
          <button
            onClick={() => setCacheMinimized(v => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: '#999',
              cursor: 'pointer',
              fontSize: '15px',
              lineHeight: 1,
              padding: '0 0 0 8px',
              fontFamily: panelFont,
            }}
            title={cacheMinimized ? 'Expand' : 'Minimize'}
          >
            {cacheMinimized ? '+' : '\u2013'}
          </button>
        </div>

        <div className="cache-panel-body" style={{
          maxHeight: cacheMinimized ? '0px' : '300px',
          opacity: cacheMinimized ? 0 : 1,
          transition: 'max-height 0.6s ease, opacity 0.4s ease, margin 0.6s ease',
          overflow: 'hidden',
          marginTop: cacheMinimized ? 0 : '6px',
        }}>
          {vehicleTimestampDisplay ? (
            <div style={{ color: '#444', lineHeight: 1.6 }}>
              <div><span style={{ color: '#888' }}>Oldest:</span> {vehicleTimestampDisplay.min}</div>
              <div><span style={{ color: '#888' }}>Newest:</span> {vehicleTimestampDisplay.max}</div>
            </div>
          ) : (
            <div style={{ color: '#999' }}>Waiting for data...</div>
          )}

          {routeInfo && (
            <>
              <div style={{ borderTop: '1px solid #e5e5e5', margin: '8px 0' }} />
              <div style={{ fontWeight: 600, fontSize: '12px', color: '#555', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Route lines
              </div>
              <div style={{ color: '#444', lineHeight: 1.6 }}>
                <div><span style={{ color: '#888' }}>Routes:</span> {routeInfo.count}</div>
                <div><span style={{ color: '#888' }}>Feed:</span> {routeInfo.vintage}</div>
              </div>
            </>
          )}

          <div style={{ borderTop: '1px solid #e5e5e5', margin: '8px 0' }} />
          <a
            href="https://kuanbutts.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#aaa', fontSize: '11px', textDecoration: 'none' }}
          >
            Made in Oakland, CA by Kuan
          </a>
        </div>
      </div>

      {/* Route picker modal */}
      {showRoutePicker && (() => {
        const transbay = routeNames.filter(n => /^[A-Za-z]/.test(n)).sort((a, b) => a.localeCompare(b));
        const local = routeNames.filter(n => /^\d/.test(n)).sort((a, b) => {
          const na = parseInt(a, 10), nb = parseInt(b, 10);
          return na !== nb ? na - nb : a.localeCompare(b);
        });

        const btnStyle: React.CSSProperties = {
          padding: '12px 0',
          minWidth: '72px',
          border: '1px solid #d4d4d4',
          borderRadius: '8px',
          background: '#fff',
          color: '#1a1a1a',
          fontSize: '15px',
          fontWeight: 600,
          fontFamily: panelFont,
          cursor: 'pointer',
          textAlign: 'center',
        };

        return (
          <div
            onClick={() => setShowRoutePicker(false)}
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 2000,
              background: 'rgba(0,0,0,0.5)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '16px',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#fff',
                borderRadius: '14px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                maxWidth: '480px',
                width: '100%',
                maxHeight: '80vh',
                overflow: 'auto',
                padding: '20px',
                fontFamily: panelFont,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ fontWeight: 700, fontSize: '18px', color: '#1a1a1a' }}>Select a route</div>
                <button
                  onClick={() => setShowRoutePicker(false)}
                  style={{
                    background: 'none', border: 'none', fontSize: '22px', color: '#888',
                    cursor: 'pointer', padding: '4px 8px', lineHeight: 1,
                  }}
                >
                  &times;
                </button>
              </div>

              {transbay.length > 0 && (
                <>
                  <div style={{ fontSize: '11px', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
                    Transbay
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
                    {transbay.map(name => (
                      <button
                        key={name}
                        onClick={() => { shouldZoomOnFilterChange.current = true; setRouteFilter(name); setShowRoutePicker(false); }}
                        style={{
                          ...btnStyle,
                          ...(routeFilter === name ? { background: '#0369a1', color: '#fff', borderColor: '#0369a1' } : {}),
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div style={{ fontSize: '11px', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '8px' }}>
                Local
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {local.map(name => (
                  <button
                    key={name}
                    onClick={() => { shouldZoomOnFilterChange.current = true; setRouteFilter(name); setShowRoutePicker(false); }}
                    style={{
                      ...btnStyle,
                      ...(routeFilter === name ? { background: '#0369a1', color: '#fff', borderColor: '#0369a1' } : {}),
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes countdown {
          from { width: 100%; }
          to { width: 0%; }
        }
        .maplibregl-popup-close-button {
          font-size: 20px;
          color: #666;
          padding: 2px 6px;
          line-height: 1;
        }
        .maplibregl-popup-close-button:hover {
          color: #000;
          background: rgba(0, 0, 0, 0.06);
          border-radius: 4px;
        }
      `}</style>
    </div>
  );
};

function App() {

  return (
    <ACTransitMap />
  )
}

export default App
