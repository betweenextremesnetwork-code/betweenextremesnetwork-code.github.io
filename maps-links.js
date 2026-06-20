// maps-links.js
// Adds chunked Google Maps + OpenStreetMap directions links and client-side geocoding for missing coords.
// Integrates with existing navLoadRoute / navInit UI by rendering into #maps-launch-area.

(function(){
  'use strict';

  // Configuration
  var GOOGLE_MAX_WAYPOINTS = 23; // safe for Google (waypoints only; origin+destination separate)
  var OSM_MAX_POINTS = 50; // OSM directions UI can accept many, but keep an upper bound for UX
  var GEOCODE_DELAY_MS = 1100; // Nominatim: ~1 request/sec polite delay
  var USER_AGENT = 'reRouter-App (betweenextremesnetwork)'; // included in fetch headers where possible

  // Utility
  function hasCoords(s) { return s && typeof s.lat === 'number' && typeof s.lng === 'number' && !isNaN(s.lat) && !isNaN(s.lng); }
  function esc(s) { return (s || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }

  // Build Google Maps URL for a slice of coordinates array (each element: "lat,lng")
  function buildGoogleMapsUrlFromCoordsArray(coordsArr) {
    if (!coordsArr || coordsArr.length < 2) return null;
    var origin = coordsArr[0];
    var destination = coordsArr[coordsArr.length - 1];
    var waypoints = coordsArr.slice(1, coordsArr.length - 1);
    var url = 'https://www.google.com/maps/dir/?api=1'
      + '&origin=' + encodeURIComponent(origin)
      + '&destination=' + encodeURIComponent(destination)
      + '&travelmode=driving';
    if (waypoints.length) {
      url += '&waypoints=' + encodeURIComponent(waypoints.join('|'));
    }
    return url;
  }

  // Chunk coordinates into groups that fit Google limits (origin + up to MAX_WAYPOINTS + destination)
  function chunkCoordsForGoogle(coordsArr, maxWaypoints) {
    maxWaypoints = maxWaypoints || GOOGLE_MAX_WAYPOINTS;
    if (!coordsArr || coordsArr.length < 2) return [];
    var chunks = [];
    // Each chunk needs origin + up to (maxWaypoints) waypoints + destination
    var i = 0;
    while (i < coordsArr.length - 1) {
      var origin = coordsArr[i];
      // We will take as many middle points as allowed, up to maxWaypoints
      var endIndex = Math.min(i + 1 + maxWaypoints + 1, coordsArr.length - 1); // -1 because destination is last in slice
      // Build the slice from origin through some subsequent points ending with a destination
      var slice = coordsArr.slice(i, endIndex + 1);
      // Ensure slice has at least 2 points
      if (slice.length < 2) slice = coordsArr.slice(i, i+2);
      chunks.push(slice);
      // Next origin should be last point of this slice (to continue seamlessly)
      i = endIndex;
    }
    return chunks;
  }

  // Build an OpenStreetMap directions link (OSRM backend) from coords (array of "lat,lng")
  // Uses the openstreetmap.org directions UI with route parameter
  function buildOsmDirectionsUrlFromCoordsArray(coordsArr) {
    if (!coordsArr || coordsArr.length < 2) return null;
    // OSM expects route=lat,lon;lat,lon;...
    var parts = coordsArr.map(function(c) {
      // coords are "lat,lng" format already
      return c.replace(',', ',');
    }).join(';');
    var url = 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=' + encodeURIComponent(parts);
    return url;
  }

  // Geocode a single address using Nominatim (forward geocode)
  // Returns a promise that resolves to {lat, lng} or null on failure
  function geocodeAddressNominatim(address) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function(res){ return res.json(); })
      .then(function(j){
        if (Array.isArray(j) && j.length) {
          return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
        }
        return null;
      })
      .catch(function(){ return null; });
  }

  // Ensure coords for all stops in a route by geocoding addresses serially with delay.
  // onProgress(index, total, success, stop) called after each attempt.
  // returns a promise that resolves to the updated route (and modifies route in-place).
  function ensureCoordsForRoute(route, onProgress) {
    var stops = route && route.stops ? route.stops : [];
    var missing = stops.reduce(function(acc, s, idx){
      if (!hasCoords(s) && s && s.address && s.address.trim()) acc.push({ stop: s, index: idx });
      return acc;
    }, []);
    if (!missing.length) return Promise.resolve(route);

    // Serially process with delay
    return new Promise(function(resolve){
      var i = 0;
      function next() {
        if (i >= missing.length) {
          resolve(route);
          return;
        }
        var item = missing[i];
        geocodeAddressNominatim(item.stop.address).then(function(coords){
          if (coords) {
            item.stop.lat = coords.lat;
            item.stop.lng = coords.lng;
          }
          if (typeof onProgress === 'function') {
            onProgress(i+1, missing.length, !!coords, item);
          }
          i++;
          setTimeout(next, GEOCODE_DELAY_MS);
        }).catch(function(){
          if (typeof onProgress === 'function') {
            onProgress(i+1, missing.length, false, item);
          }
          i++;
          setTimeout(next, GEOCODE_DELAY_MS);
        });
      }
      next();
    });
  }

  // Render maps UI into the #maps-launch-area element for a given route index
  function renderMapsUIForRouteIndex(routeIndex) {
    var el = document.getElementById('maps-launch-area');
    if (!el) return;
    el.innerHTML = '';
    if (!window.routes || !window.routes[routeIndex]) {
      el.innerHTML = '<div style="color:var(--muted)">No route selected</div>';
      return;
    }
    var route = window.routes[routeIndex];

    // Prepare coords (lat,lng strings) for stops that have coords
    var coordsArr = (route.stops || []).map(function(s){ return hasCoords(s) ? (s.lat + ',' + s.lng) : null; }).filter(Boolean);

    // Show geocode button if there are stops without coords but with addresses
    var stopsWithoutCoordsWithAddr = (route.stops || []).filter(function(s){ return !hasCoords(s) && s && s.address && s.address.trim(); });
    if (stopsWithoutCoordsWithAddr.length) {
      var geocodeWrap = document.createElement('div');
      geocodeWrap.style.marginBottom = '10px';
      var geocodeBtn = document.createElement('button');
      geocodeBtn.className = 'btn btn-outline';
      geocodeBtn.textContent = 'Geocode missing addresses (' + stopsWithoutCoordsWithAddr.length + ')';
      geocodeBtn.onclick = function(){
        geocodeBtn.disabled = true;
        geocodeBtn.textContent = 'Geocoding...';
        var progress = document.createElement('div');
        progress.style.marginTop = '8px';
        progress.style.color = 'var(--muted)';
        progress.textContent = 'Starting...';
        geocodeWrap.appendChild(progress);
        ensureCoordsForRoute(route, function(done, total, success, item){
          progress.textContent = 'Processed ' + done + ' / ' + total + ': ' + (success ? 'OK' : 'Failed') + ' — ' + (item && item.stop && item.stop.address ? item.stop.address : '');
          if (done === total) {
            progress.textContent = 'Geocoding complete';
            geocodeBtn.textContent = 'Geocoding complete';
            geocodeBtn.disabled = false;
            // update stored routes if storeSave available
            if (typeof storeSave === 'function') try { storeSave(); } catch(e){ /* ignore */ }
            // Re-render UI with newly populated coords
            renderMapsUIForRouteIndex(routeIndex);
          }
        });
      };
      geocodeWrap.appendChild(geocodeBtn);
      el.appendChild(geocodeWrap);
    }

    if (coordsArr.length < 2) {
      var info = document.createElement('div');
      info.className = 'card';
      info.style.padding = '12px';
      info.textContent = 'Not enough coordinates to build directions (need at least 2 stops with lat/lng).';
      el.appendChild(info);
      return;
    }

    // GOOGLE LINKS (chunked)
    var googleChunks = chunkCoordsForGoogle(coordsArr, GOOGLE_MAX_WAYPOINTS);
    if (googleChunks.length) {
      var gHeader = document.createElement('div');
      gHeader.style.margin = '8px 0 6px';
      gHeader.style.fontSize = '13px';
      gHeader.style.color = 'var(--muted)';
      gHeader.textContent = 'Google Maps';
      el.appendChild(gHeader);
      googleChunks.forEach(function(chunk, idx){
        var url = buildGoogleMapsUrlFromCoordsArray(chunk);
        var a = document.createElement('a');
        a.className = 'btn btn-primary';
        a.style.display = 'inline-block';
        a.style.marginRight = '8px';
        a.style.marginBottom = '8px';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open in Google Maps — part ' + (idx+1) + ' / ' + googleChunks.length;
        el.appendChild(a);
      });
      if (googleChunks.length > 1) {
        var gNote = document.createElement('div');
        gNote.style.fontSize = '12px';
        gNote.style.color = 'var(--muted)';
        gNote.style.marginBottom = '8px';
        gNote.textContent = 'Route split into ' + googleChunks.length + ' trips to accommodate Google Maps waypoint limits.';
        el.appendChild(gNote);
      }
    }

    // OPENSTREETMAP (OSRM) LINKS (chunked)
    var osmChunks = [];
    // chunk simply: create slices of up to OSM_MAX_POINTS each, overlapping endpoints to maintain continuity
    var idx = 0;
    while (idx < coordsArr.length - 1) {
      var end = Math.min(idx + OSM_MAX_POINTS, coordsArr.length);
      var slice = coordsArr.slice(idx, end);
      if (slice.length < 2 && idx + 1 < coordsArr.length) slice = coordsArr.slice(idx, idx+2);
      osmChunks.push(slice);
      idx = end - 1; // overlap last point as origin for next
    }

    if (osmChunks.length) {
      var oHeader = document.createElement('div');
      oHeader.style.margin = '12px 0 6px';
      oHeader.style.fontSize = '13px';
      oHeader.style.color = 'var(--muted)';
      oHeader.textContent = 'OpenStreetMap (OSRM)';
      el.appendChild(oHeader);
      osmChunks.forEach(function(chunk, i2){
        var url = buildOsmDirectionsUrlFromCoordsArray(chunk);
        var a = document.createElement('a');
        a.className = 'btn btn-outline';
        a.style.display = 'inline-block';
        a.style.marginRight = '8px';
        a.style.marginBottom = '8px';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Open in OSM — part ' + (i2+1) + ' / ' + osmChunks.length;
        el.appendChild(a);
      });
    }

  } // renderMapsUIForRouteIndex

  // Wrap existing navLoadRoute if present, otherwise define a simple one
  function installWrapper() {
    // If there's an existing navLoadRoute, preserve it
    var originalNavLoadRoute = window.navLoadRoute;
    window.navLoadRoute = function(i) {
      try {
        if (typeof originalNavLoadRoute === 'function') {
          originalNavLoadRoute(i);
        } else {
          // If not present, attempt a best-effort UI change to show route details
          var route = (window.routes && window.routes[i]) ? window.routes[i] : null;
          if (route) {
            // attempt to set some fields that exist in the original app
            var nameEl = document.getElementById('nav-route-name');
            if (nameEl) nameEl.textContent = route.name || '–';
            var metaEl = document.getElementById('nav-route-meta');
            if (metaEl) metaEl.textContent = (route.stops ? route.stops.length : 0) + ' stop' + ((route.stops && route.stops.length) !== 1 ? 's' : '');
            var picker = document.getElementById('nav-picker');
            var active = document.getElementById('nav-active');
            if (picker) picker.style.display = 'none';
            if (active) active.style.display = 'flex';
          }
        }
      } catch(e) {
        console.warn('navLoadRoute wrapper original failed', e);
      }
      // always render maps UI after the original navLoadRoute finishes
      setTimeout(function(){ renderMapsUIForRouteIndex(i); }, 120);
    };

    // If navInit exists, wrap it to ensure maps UI is cleared/initialized
    var originalNavInit = window.navInit;
    window.navInit = function() {
      try {
        if (typeof originalNavInit === 'function') originalNavInit();
      } catch(e) { /* ignore */ }
      // Clear maps area until a route is selected
      var el = document.getElementById('maps-launch-area');
      if (el) el.innerHTML = '<div style="color:var(--muted)">Select a route to open directions</div>';
    };
  }

  // Execute install on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installWrapper);
  } else {
    installWrapper();
  }

  // Expose helper functions for debugging if needed
  window._rr_maps_helpers = {
    buildGoogleMapsUrlFromCoordsArray: buildGoogleMapsUrlFromCoordsArray,
    buildOsmDirectionsUrlFromCoordsArray: buildOsmDirectionsUrlFromCoordsArray,
    ensureCoordsForRoute: ensureCoordsForRoute,
    renderMapsUIForRouteIndex: renderMapsUIForRouteIndex
  };

})();
