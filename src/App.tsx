import './App.css'

import React, { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

const ACTransitMap = () => {
  const mapContainer = useRef();
  const map = useRef();
  const [busData, setBusData] = useState([]);
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
      setBusData(data);
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

    const features = busData.map((bus, index) => {
      const lat = bus.vehicle.position.latitude;
      const lng = bus.vehicle.position.longitude;
      const bearing = bus.vehicle.position.bearing;
      const speed = bus.vehicle.position.speed;
      
      console.log(`Bus ${index}:`, { lat, lng, bearing, vehicleId: bus.vehicle_id || bus.id });
      
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        properties: {
          bearing: bearing,
          vehicleId: bus.vehicle.vehicle.id,
          speed: speed,
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
      
      map.current.fitBounds(bounds, { padding: 50 });
      console.log('Fitted bounds to show all buses');
    }
  }, [busData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchBusLocations, 30000);
    return () => clearInterval(interval);
  }, []);

  // Add click handler for bus details
  useEffect(() => {
    if (!map.current) return;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false
    });

    const handleClick = (e) => {
      const features = map.current.queryRenderedFeatures(e.point, {
        layers: ['bus-arrows']
      });

      if (features.length > 0) {
        const feature = features[0];
        const { vehicleId, route, bearing } = feature.properties;
        
        popup
          .setLngLat(feature.geometry.coordinates)
          .setHTML(`
            <div style="font-family: Arial, sans-serif; font-size: 12px;">
              <strong>Vehicle ${vehicleId}</strong><br/>
              Route: ${route}<br/>
              Bearing: ${Math.round(bearing)}°
            </div>
          `)
          .addTo(map.current);
      } else {
        popup.remove();
      }
    };

    map.current.on('click', 'bus-arrows', handleClick);
    map.current.on('mouseenter', 'bus-arrows', () => {
      map.current.getCanvas().style.cursor = 'pointer';
    });
    map.current.on('mouseleave', 'bus-arrows', () => {
      map.current.getCanvas().style.cursor = '';
      popup.remove();
    });

    return () => {
      if (map.current) {
        map.current.off('click', 'bus-arrows', handleClick);
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

      {/* Legend */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        right: '20px',
        background: 'rgba(255, 255, 255, 0.95)',
        padding: '12px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        fontFamily: 'Arial, sans-serif',
        fontSize: '12px',
        zIndex: 1000
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '16px',
            height: '16px',
            background: '#ff4444',
            clipPath: 'polygon(50% 0%, 20% 100%, 80% 100%)',
            border: '1px solid white'
          }}></div>
          <span style={{ color: '#333' }}>Bus (arrow shows direction)</span>
        </div>
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
