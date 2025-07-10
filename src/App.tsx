import './App.css'

import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

let BUS_LOCATIONS_FETCH_COUNT = 0;
const MAX_MINUTES_AGO = 8;

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
      const response = await fetch('https://actransit.val.run/bus_locations');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      console.log('Bus data received:', data);
      BUS_LOCATIONS_FETCH_COUNT += 1;
      setBusData(data);

      setLoading(true);
      const historyResponse = await fetch('https://actransit.val.run/bus_locations_history');
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
    }
  };

  // Fetch route stop predictions
  const fetchRouteStopPredictions = async () => {
    try {
      const response = await fetch('https://actransit.val.run/route_stop_predictions');
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
      style: 'https://api.maptiler.com/maps/streets/style.json?key=smyKrds9C01IazzvU1Tr',
      center: [-122.2681, 37.8044], // Oakland, CA center
      zoom: 10
    });

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

      // Add source for bus history lines
      map.current.addSource('busesHistoryLines', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
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
        paint: {
          'circle-radius': 4,
          'circle-color': '#0066cc',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': 0.45
        }
      });

      // Add layer for bus arrows
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
            8, 0.1,    // At zoom 8, size = 0.3
            10, 0.2,   // At zoom 10, size = 0.5
            12, 0.4,   // At zoom 12, size = 0.8
            15, 0.7,   // At zoom 15, size = 1.2
            18, 1,     // At zoom 15, size = 1.2
            20, 1.2,
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

      // Add layer for bus arrows
      map.current.addLayer({
        id: 'bus-history',
        type: 'symbol',
        source: 'busesHistory',
        layout: {
          'icon-image': 'bus',
          'icon-size': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 0.1,    // At zoom 8, size = 0.3
            10, 0.2,   // At zoom 10, size = 0.5
            12, 0.4,   // At zoom 12, size = 0.8
            15, 0.7,   // At zoom 15, size = 1.2
            18, 1,     // At zoom 15, size = 1.2
            20, 1.2,
          ],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        },
        paint: {
          'icon-color': '#ff4444',
          'icon-opacity': [
            'case',
            ['==', ['get', 'show-history'], true],
            0.3,
            0
          ]
        }
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
          'line-color': '#ff6666',
          'line-width': 2,
          'line-opacity': [
            'case',
            ['==', ['get', 'show-history'], true],
            0.4,
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
        feature.properties.routeId.includes(routeFilter.trim())
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

    // Fit map to show all buses if we have valid coordinates
    if (features.length > 0) {
      const coordinates = features.map(f => f.geometry.coordinates);
      const bounds = coordinates.reduce((bounds, coord) => {
        return bounds.extend(coord);
      }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

      if (BUS_LOCATIONS_FETCH_COUNT === 1) map.current.fitBounds(bounds, { padding: 50 });
      console.log('Fitted bounds to show all buses');
    }
  }, [busData, routeFilter, activeStopFilter]);

  // Calculate filtered bus count
  const filteredBusCount = React.useMemo(() => {
    if (!routeFilter.trim()) return busData.length;
    
    const features = convertBusDataToFeatures(busData);
    return features.filter(feature => 
      feature.properties.routeId && 
      feature.properties.routeId.includes(routeFilter.trim())
    ).length;
  }, [busData, routeFilter]);

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
        // Sort points by timestamp
        const sortedPoints = points.sort((a, b) => a.properties.timestamp - b.properties.timestamp);
        const tripId = sortedPoints[0].properties.tripId;
        
        // Add current bus location if it exists
        let allCoordinates = sortedPoints.map(point => point.geometry.coordinates);
        if (currentBusMap[tripId]) {
          allCoordinates.push(currentBusMap[tripId].geometry.coordinates);
        }
        
        return {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: allCoordinates
          },
          properties: {
            tripId: tripId,
            routeId: sortedPoints[0].properties.routeId,
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
          routeName.includes(routeFilter.trim())
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

    const handleClick = (e) => {
      const features = map.current.queryRenderedFeatures(e.point, {
        layers: ['bus-arrows']
      });

      if (features.length > 0) {
        const feature = features[0];
        const { routeId, bearing, tripId, speed } = feature.properties;

        // Show history for matching trip IDs
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

        // Get pre-calculated average speed
        console.log('tripAverageSpeeds from ref:', tripAverageSpeedsRef.current);
        console.log('tripId being looked up:', tripId);
        console.log('Available tripIds in ref:', Object.keys(tripAverageSpeedsRef.current));
        const historicalAvgMPH = tripAverageSpeedsRef.current[tripId] || null;
        console.log('historicalAvgMPH found:', historicalAvgMPH);
        const htmlString = `
          <div style="font-family: Arial, sans-serif; font-size: 12px; color: #000">
            <strong>Route: ${routeId}</strong><br/>
            Trip: ${tripId}<br/>
            Bearing: ${Math.round(bearing)}°<br/>
            Speed: ${Math.round(speed)} mph<br/>
            ${historicalAvgMPH ? `Avg Speed: ${historicalAvgMPH} mph` : ''}
          </div>`

        popup
          .setLngLat(feature.geometry.coordinates)
          .setHTML(htmlString)
          .addTo(map.current);
      } else {
        popup.remove();
        
        // Hide all history when clicking elsewhere
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
        const { tripId } = feature.properties;

        // Show history for matching trip IDs on hover
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
      // Hide all history when mouse leaves

      // Hide history for busesHistory
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
          <div style="font-family: Arial, sans-serif; font-size: 12px; color: #000">
            <strong>Stop ID: ${stpid}</strong><br/>
            ${stpnm ? `Name: ${stpnm}<br/>` : ''}
            Routes: ${routeNames ? routeNames : 'None'}
          </div>`

        popup
          .setLngLat(feature.geometry.coordinates)
          .setHTML(htmlString)
          .addTo(map.current);
      } else {
        popup.remove();
        setActiveStopFilter(null);
      }
    };

    map.current.on('click', 'stops-circles', handleStopClick);
    map.current.on('mouseenter', 'stops-circles', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });

    return () => {
      if (map.current) {
        map.current.off('click', 'bus-arrows', handleClick);
        map.current.off('mouseenter', 'bus-arrows', handleMouseEnter);
        map.current.off('mouseleave', 'bus-arrows', handleMouseLeave);
        map.current.off('click', 'stops-circles', handleStopClick);
      }
    };
  }, []);

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative', backgroundColor: 'red' }}>
      {/* Map container */}
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      
      {/* Status overlay */}
      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        background: 'rgba(255, 255, 255, 0.95)',
        padding: '15px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        maxWidth: '300px',
        zIndex: 1000
      }}>
        <h3 style={{ 
          margin: '0 0 10px 0', 
          fontSize: '18px', 
          color: '#333',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          🚌 AC Transit Live Map
        </h3>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#666' }}>
            <div style={{
              width: '16px',
              height: '16px',
              border: '2px solid #007cba',
              borderTop: '2px solid transparent',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite'
            }}></div>
            Loading bus locations...
          </div>
        )}
        {error && (
          <div style={{ 
            margin: '5px 0', 
            color: '#dc3545',
            padding: '8px',
            background: '#f8d7da',
            borderRadius: '4px',
            fontSize: '12px'
          }}>
            ❌ {error}
          </div>
        )}
        {!loading && !error && (
          <div>
            <div style={{ 
              margin: '5px 0', 
              color: '#333',
              display: 'flex',
              alignItems: 'center',
              gap: '5px'
            }}>
              <span style={{ 
                background: '#28a745', 
                color: 'white', 
                padding: '2px 6px', 
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 'bold'
              }}>
                {filteredBusCount}
              </span>
              buses tracked
            </div>
            {routeFilter.trim() && (
              <div style={{ 
                margin: '2px 0', 
                color: '#666',
                fontSize: '11px',
                fontStyle: 'italic'
              }}>
                filtered to {filteredBusCount} of {busData.length} total
              </div>
            )}
            <p style={{ margin: '5px 0', color: '#666', fontSize: '12px' }}>
              🔄 Updates every 30 seconds
            </p>
          </div>
        )}
        
        {/* Route Filter */}
        <div style={{ marginTop: '10px' }}>
          <label style={{ 
            display: 'block', 
            fontSize: '12px', 
            color: '#333', 
            marginBottom: '5px',
            fontWeight: 'bold'
          }}>
            Route Filter:
          </label>
          <input
            type="text"
            value={routeFilter}
            onChange={(e) => setRouteFilter(e.target.value)}
            placeholder="e.g., 33, 51, 800..."
            style={{
              width: '100%',
              padding: '8px 10px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '12px',
              boxSizing: 'border-box'
            }}
          />
          {routeFilter && (
            <div style={{ 
              marginTop: '5px', 
              fontSize: '11px', 
              color: '#666',
              fontStyle: 'italic'
            }}>
              Showing buses with route ID containing "{routeFilter}"
            </div>
          )}
        </div>
        <button
          onClick={fetchBusLocations}
          disabled={loading}
          style={{
            marginTop: '10px',
            padding: '10px 16px',
            background: loading ? '#ccc' : 'linear-gradient(135deg, #007cba, #005a8b)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '12px',
            fontWeight: 'bold',
            transition: 'all 0.2s',
            width: '100%'
          }}
        >
          {loading ? '🔄 Refreshing...' : '🔄 Refresh Now'}
        </button>

        {/* Show All Button */}
        <button
          onClick={() => {
            setRouteFilter('');
            setActiveStopFilter(null);
            // Clear any active popups
            if (map.current) {
              const popups = document.querySelectorAll('.maplibre-popup');
              popups.forEach(popup => popup.remove());
            }
          }}
          style={{
            marginTop: '8px',
            padding: '8px 12px',
            background: 'linear-gradient(135deg, #28a745, #20c997)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 'bold',
            transition: 'all 0.2s',
            width: '100%'
          }}
        >
          🌐 Show All
        </button>
      </div>

      {/* CSS for animations */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
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
