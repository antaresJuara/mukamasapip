const SUPABASE_URL      = 'https://ijmocseakuergwqcfdtu.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqbW9jc2Vha3Vlcmd3cWNmZHR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1ODk4MzYsImV4cCI6MjA5NDE2NTgzNn0.yyi2OFGIpJDfXjt3ic12jtyaq7nLlZF39Os0Ac1Pzl4'
const MAPTILER_KEY = 'e58oYGqm2yM81XwdwquS'
const MAX_TRAIL    = 200

const DISCONNECT_TIMEOUT = 5000 // 5 detik

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

let lastDataTime = null

function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('id-ID', { hour12: false })
}
setInterval(updateClock, 1000)
updateClock()

function setStatus(connected) {
  const badge = document.getElementById('status-badge')
  const text  = document.getElementById('status-text')
  if (connected) {
    badge.className = 'connected'
    text.textContent = 'CONNECTED'
  } else {
    badge.className = 'disconnected'
    text.textContent = 'DISCONNECTED'
  }
}

setInterval(() => {
  if (lastDataTime && Date.now() - lastDataTime > DISCONNECT_TIMEOUT) {
    setStatus(false)
  }
}, 1000)


function updateBattery(pct) {
  const fill = document.getElementById('bat-fill')
  const icon = document.getElementById('bat-icon')
  const text = document.getElementById('bat-pct')

  const p = Math.max(0, Math.min(100, pct))
  text.textContent = p + '%'
  fill.style.width = p + '%'

  let color
  if (p > 50)      color = 'var(--accent2)'
  else if (p > 20) color = 'var(--warn)'
  else             color = 'var(--danger)'

  fill.style.background = color
  icon.style.color      = color
  text.style.color      = color
}

// ── COMPASS ──
function updateCompass(deg) {
  document.getElementById('compass-needle').style.transform = `rotate(${deg}deg)`
  document.getElementById('heading-val').textContent = deg
}

function renderTelemetry(data) {
  lastDataTime = Date.now()
  setStatus(true)

  document.getElementById('lat').textContent        = data.latitude?.toFixed(6)   ?? '--'
  document.getElementById('lon').textContent        = data.longitude?.toFixed(6)  ?? '--'
  document.getElementById('speed-ms').textContent   = data.speed_ms?.toFixed(2)   ?? '-.-'
  document.getElementById('speed-knot').textContent = data.speed_knot?.toFixed(2) ?? '-.-'
  document.getElementById('last-ts').textContent    = data.timestamp ?? '--'

  updateBattery(data.battery_pct ?? 0)
  updateCompass(data.heading ?? 0)

  const ts = data.timestamp
    ? new Date(data.timestamp).toLocaleTimeString('id-ID')
    : '--'
  document.getElementById('last-update').textContent = 'Last update: ' + ts
}

function renderLog(logs) {
  const box = document.getElementById('log-box')
  box.innerHTML = ''
  logs.forEach(log => {
    appendLog(log)
  })
}

function appendLog(log) {
  const box = document.getElementById('log-box')
  const ts  = new Date(log.timestamp).toLocaleTimeString('id-ID')
  const div = document.createElement('div')
  div.className = 'log-entry'
  div.innerHTML = `<span class="ts">[${ts}]</span><span class="msg">${log.message}</span>`
  box.insertBefore(div, box.firstChild)
}

// ── INITIAL LOAD ──
async function loadInitial() {
  const { data: tel } = await db
    .from('telemetry')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(1)
    .single()

  if (tel) renderTelemetry(tel)

  const { data: logs } = await db
    .from('system_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .limit(20)

  if (logs) renderLog(logs)
}

// ── REALTIME SUBSCRIPTION ──
function subscribeRealtime() {
  db.channel('realtime-telemetry')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'telemetry'
    }, payload => {
      renderTelemetry(payload.new)
    })
    .subscribe()

  db.channel('realtime-logs')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'system_logs'
    }, payload => {
      appendLog(payload.new)
    })
    .subscribe()
}

// ── TRAJECTORY MAP ──
let trailPoints = []
let trailMarkers = []
let polyline    = null
let liveMarker  = null
let followMode  = true
let lastPointTime = -Infinity

const map = L.map('map', { zoomControl: true })
             .setView([-7.5613, 110.8574], 17)

L.tileLayer(
  `https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=${MAPTILER_KEY}`,
  { attribution: '© MapTiler © OpenStreetMap', tileSize: 512, zoomOffset: -1 }
).addTo(map)

map.on('load', () => {
  console.log('Map loaded successfully')
})

// Test marker untuk memastikan map bekerja
L.marker([-7.5613, 110.8574]).addTo(map).bindPopup('Test Marker').openPopup()

async function loadTrajectoryHistory() {
  const { data, error } = await db
    .from('trajectory_map')
    .select('latitude, longitude, timestamp')
    .order('timestamp', { ascending: true })
    .limit(MAX_TRAIL)

  if (error) {
    console.error('Error loading trajectory:', error)
    return
  }
  
  if (!data?.length) {
    console.log('No trajectory data found - adding dummy data for testing')
    // Tambah data dummy untuk testing
    const dummyData = [
      { latitude: -7.5613, longitude: 110.8574, timestamp: new Date(Date.now() - 10000).toISOString() },
      { latitude: -7.5615, longitude: 110.8576, timestamp: new Date(Date.now() - 5000).toISOString() },
      { latitude: -7.5617, longitude: 110.8578, timestamp: new Date().toISOString() }
    ]
    dummyData.forEach(r => plotPoint(parseFloat(r.latitude), parseFloat(r.longitude)))
    return
  }

  console.log(`Loaded ${data.length} trajectory points`)

  // Filter data dengan interval 1.5 detik
  let filteredData = []
  let lastTs = -Infinity
  data.forEach(r => {
    const ts = new Date(r.timestamp).getTime()
    if (ts - lastTs >= 1500) {
      filteredData.push(r)
      lastTs = ts
    }
  })

  console.log(`Filtered to ${filteredData.length} points (1.5s interval)`)
  filteredData.forEach(r => plotPoint(parseFloat(r.latitude), parseFloat(r.longitude)))

  if (trailMarkers.length > 1) {
    const group = L.featureGroup(trailMarkers)
    map.fitBounds(group.getBounds(), { padding: [40, 40] })
  }
}

function plotPoint(lat, lon) {
  const now = Date.now()
  
  // Skip jika interval belum 1.5 detik (kecuali titik pertama)
  if (trailPoints.length > 0 && now - lastPointTime < 1500) {
    console.log('Skipping point - too soon after last point')
    return
  }
  lastPointTime = now

  trailPoints.push([lat, lon])
  if (trailPoints.length > MAX_TRAIL) {
    const oldMarker = trailMarkers.shift()
    if (oldMarker) map.removeLayer(oldMarker)
    trailPoints.shift()
  }

  // Tambah circle marker untuk trajectory point
  const marker = L.circleMarker([lat, lon], {
    color: '#00d4ff',
    fillColor: '#00d4ff',
    fillOpacity: 0.75,
    radius: 3,
    weight: 1
  }).addTo(map)
  trailMarkers.push(marker)
  console.log(`Added trajectory point: ${lat.toFixed(6)}, ${lon.toFixed(6)}`)

  // Update live marker (ship icon)
  const liveIcon = L.divIcon({
    className: 'live-marker-container',
    html: `<div class="live-marker" style="width: 30px; height: 30px; background: url('/mukamasapip/assets/ship.png') no-repeat center; background-size: contain;"></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  })

  if (liveMarker) {
    liveMarker.setLatLng([lat, lon])
  } else {
    liveMarker = L.marker([lat, lon], { icon: liveIcon }).addTo(map)
  }

  if (followMode) map.setView([lat, lon], map.getZoom())

  document.getElementById('map-title').textContent =
    `Trajectory Mapping  ·  ${trailPoints.length} pts`
}

// Realtime trajectory
db.channel('realtime-trajectory')
  .on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'trajectory_map'
  }, payload => {
    const r = payload.new
    if (r.latitude && r.longitude)
      plotPoint(parseFloat(r.latitude), parseFloat(r.longitude))
  })
  .subscribe()

// Klik peta = stop follow, double klik = follow lagi
map.on('mousedown', () => { followMode = false })
map.on('dblclick',  () => {
  followMode = true
  if (liveMarker) map.setView(liveMarker.getLatLng(), map.getZoom())
})

// ── START ──
loadInitial()
subscribeRealtime()
loadTrajectoryHistory()