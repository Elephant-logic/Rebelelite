const socket = io();

const $ = id => document.getElementById(id);

const publicRoomsGrid = $('publicRoomsGrid');
const publicRoomsEmpty = $('publicRoomsEmpty');
const refreshRoomsBtn = $('refreshRoomsBtn');
const claimRoomForm = $('claimRoomForm');
const claimRoomStatus = $('claimRoomStatus');
const hostRoomForm = $('hostRoomForm');
const hostRoomStatus = $('hostRoomStatus');
const vipCodeForm = $('vipCodeForm');
const vipCodeStatus = $('vipCodeStatus');

function setStatus(el, message, type) {
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('ok', 'error');
  if (type) el.classList.add(type);
}

function renderRooms(rooms) {
  if (!publicRoomsGrid) return;
  publicRoomsGrid.innerHTML = '';
  const list = Array.isArray(rooms) ? rooms : [];

  if (!list.length) {
    if (publicRoomsEmpty) publicRoomsEmpty.style.display = 'block';
    return;
  }

  if (publicRoomsEmpty) publicRoomsEmpty.style.display = 'none';
  list.forEach(room => {
    const card = document.createElement('div');
    card.className = 'room-card';

    const title = document.createElement('h3');
    title.textContent = room.name || 'Untitled Room';

    const meta = document.createElement('div');
    meta.className = 'room-meta';
    const viewers = typeof room.viewers === 'number' ? room.viewers : 0;
    meta.textContent = `${viewers} viewers`;

    const description = document.createElement('div');
    description.className = 'landing-muted';
    description.textContent = room.title ? room.title : 'Live now';

    const watchBtn = document.createElement('button');
    watchBtn.className = 'btn small primary';
    watchBtn.textContent = 'Watch';
    watchBtn.onclick = () => {
      const target = `/view.html?room=${encodeURIComponent(room.name)}`;
      window.location.href = target;
    };

    card.appendChild(title);
    card.appendChild(description);
    card.appendChild(meta);
    card.appendChild(watchBtn);
    publicRoomsGrid.appendChild(card);
  });
}

function requestPublicRooms() {
  socket.emit('get-public-rooms');
}

socket.on('public-rooms', renderRooms);

if (refreshRoomsBtn) {
  refreshRoomsBtn.onclick = requestPublicRooms;
}

if (claimRoomForm) {
  claimRoomForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = $('claimRoomName')?.value.trim();
    const password = $('claimRoomPassword')?.value.trim();
    const privacyValue = $('claimRoomPrivacy')?.value || 'public';
    const isPublic = privacyValue === 'public';

    if (!name || !password) {
      setStatus(claimRoomStatus, 'Room name and password are required.', 'error');
      return;
    }

    setStatus(claimRoomStatus, 'Claiming room...', '');
    socket.emit('claim-room', { name, password, public: isPublic }, response => {
      if (response?.ok) {
        setStatus(claimRoomStatus, 'Room claimed. Keep your password safe.', 'ok');
      } else {
        setStatus(claimRoomStatus, response?.error || 'Unable to claim room.', 'error');
      }
    });
  });
}

if (hostRoomForm) {
  hostRoomForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = $('hostRoomName')?.value.trim();
    const password = $('hostRoomPassword')?.value.trim();

    if (!name) {
      setStatus(hostRoomStatus, 'Room name is required.', 'error');
      return;
    }

    setStatus(hostRoomStatus, 'Checking room status...', '');
    socket.emit('check-room-claimed', { roomName: name }, claimedResp => {
      if (!claimedResp?.claimed) {
        window.location.href = `/index.html?room=${encodeURIComponent(name)}&role=host`;
        return;
      }

      if (claimedResp?.hasPassword && !password) {
        setStatus(hostRoomStatus, 'Host password required for claimed rooms.', 'error');
        return;
      }

      if (!claimedResp?.hasPassword) {
        window.location.href = `/index.html?room=${encodeURIComponent(name)}&role=host`;
        return;
      }

      setStatus(hostRoomStatus, 'Checking room ownership...', '');
      socket.emit('auth-host-room', { roomName: name, password }, response => {
        if (response?.ok) {
          sessionStorage.setItem(`hostPassword:${name}`, password);
          window.location.href = `/index.html?room=${encodeURIComponent(name)}&role=host&authed=1`;
        } else {
          setStatus(hostRoomStatus, response?.error || 'Unable to authenticate room.', 'error');
        }
      });
    });
  });
}

if (vipCodeForm) {
  vipCodeForm.addEventListener('submit', event => {
    event.preventDefault();
    const code = $('vipCodeInput')?.value.trim();
    const desiredName = $('vipDisplayNameInput')?.value.trim();

    if (!code) {
      setStatus(vipCodeStatus, 'VIP code is required.', 'error');
      return;
    }

    setStatus(vipCodeStatus, 'Checking VIP code...', '');
    socket.emit('redeem-vip-code', { code, desiredName }, response => {
      if (response?.ok && response?.roomName) {
        const params = new URLSearchParams({
          room: response.roomName,
          role: 'vip'
        });
        if (response.vipToken) params.set('vipToken', response.vipToken);
        if (desiredName) params.set('name', desiredName);
        window.location.href = `/view.html?${params.toString()}`;
      } else {
        setStatus(vipCodeStatus, 'Invalid or expired VIP code.', 'error');
      }
    });
  });
}

requestPublicRooms();
