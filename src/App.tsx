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
  const mapContainer = useRef();
  const map = useRef();
  const [busData, setBusData] = useState([]);
  const [busHistoryData, setBusHistoryData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
      setBusHistoryData(historyData);

      setError(null);
    } catch (err) {
      setError(`Failed to set bus locations: ${err.message}`);
      console.error('Error fetching bus data:', err);
    } finally {
      setLoading(false);
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

    const features = convertBusDataToFeatures(busData);

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
  }, [busData]);

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
        const { routeId, bearing, tripId } = feature.properties;

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

        const htmlString = `
          <div style="font-family: Arial, sans-serif; font-size: 12px; color: #000">
            <strong>Route: ${routeId}</strong><br/>
            Trip: ${tripId}<br/>
            Bearing: ${Math.round(bearing)}°
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

      // Hide all history lines when mouse leaves
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

    return () => {
      if (map.current) {
        map.current.off('click', 'bus-arrows', handleClick);
        map.current.off('mouseenter', 'bus-arrows', handleMouseEnter);
        map.current.off('mouseleave', 'bus-arrows', handleMouseLeave);
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
                {busData.length}
              </span>
              buses tracked
            </div>
            <p style={{ margin: '5px 0', color: '#666', fontSize: '12px' }}>
              🔄 Updates every 30 seconds<br/>
              📍 Click arrows for details
            </p>
          </div>
        )}
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
