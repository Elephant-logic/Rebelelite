const socket = io();
const stripe = Stripe('pk_test_51SsX9pRFqLkt0e4AXNSDtDd7pVMphxzwTajKuDONeqQa8IxIz8q5LZpcxMOyIcocycOa9oBHjkzWJrUEmPB9Hojp00yaUacnnu');

const $ = id => document.getElementById(id);

// Existing elements
const publicRoomsGrid = $('publicRoomsGrid');
const publicRoomsEmpty = $('publicRoomsEmpty');
const refreshRoomsBtn = $('refreshRoomsBtn');
const hostRoomForm = $('hostRoomForm');
const hostRoomStatus = $('hostRoomStatus');

// NEW: Foundation elements
const checkNameForm = $('checkNameForm');
const purchaseRoomNameInput = $('purchaseRoomName');
const nameCheckResult = $('nameCheckResult');
const purchaseStep1 = $('purchaseStep1');
const purchaseStep2 = $('purchaseStep2');
const purchaseForm = $('purchaseForm');
const confirmedRoomName = $('confirmedRoomName');
const purchaseStatus = $('purchaseStatus');
const backToStep1Btn = $('backToStep1');
const foundationCounter = $('foundationCounter');
const foundationProgressBar = $('foundationProgressBar');
const foundationProgressText = $('foundationProgressText');
const statSold = $('statSold');
const statRemaining = $('statRemaining');

let selectedRoomName = '';

function setStatus(el, message, type) {
  if (!el) return;
  el.textContent = message || '';
  el.classList.remove('ok', 'error');
  if (type) el.classList.add(type);
}

// NEW: Update Foundation stats
function updateFoundationStats(status) {
  if (!status) return;

  const { totalSold, remaining, percentSold } = status;

  if (foundationCounter) {
    foundationCounter.textContent = `${remaining} Foundation Rooms Remaining`;
  }
  if (foundationProgressBar) {
    foundationProgressBar.style.width = `${percentSold}%`;
  }
  if (foundationProgressText) {
    foundationProgressText.textContent = `${percentSold}% Claimed`;
  }
  if (statSold) {
    statSold.textContent = totalSold.toLocaleString();
  }
  if (statRemaining) {
    statRemaining.textContent = remaining.toLocaleString();
  }

  // Visual urgency
  if (foundationProgressBar) {
    if (percentSold >= 90) {
      foundationProgressBar.style.background = '#ff4b6a';
    } else if (percentSold >= 75) {
      foundationProgressBar.style.background = '#ffb84d';
    }
  }
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
    
    // NEW: Add foundation class
    if (room.isFoundationRoom) {
      card.classList.add('foundation-room');
    }

    const title = document.createElement('h3');
    title.textContent = room.name || 'Untitled Room';
    
    // NEW: Add foundation badge
    if (room.isFoundationRoom) {
      const badge = document.createElement('span');
      badge.className = 'badge-foundation';
      badge.textContent = '⭐ FOUNDATION';
      title.appendChild(badge);
    }

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

// NEW: Foundation update handler
socket.on('foundation-update', (status) => {
  console.log('[Foundation] Update:', status);
  updateFoundationStats(status);
});

// NEW: Check room name availability
if (checkNameForm) {
  checkNameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const roomName = purchaseRoomNameInput.value.trim().toLowerCase();
    
    if (!/^[a-z0-9-]{3,32}$/.test(roomName)) {
      nameCheckResult.className = 'name-check-result taken';
      nameCheckResult.textContent = '✗ Invalid format. Use 3-32 lowercase letters, numbers, or hyphens.';
      return;
    }

    nameCheckResult.textContent = 'Checking availability...';
    nameCheckResult.className = 'name-check-result';

    try {
      const response = await fetch(`/api/foundation/check/${encodeURIComponent(roomName)}`);
      const data = await response.json();

      if (data.available) {
        selectedRoomName = roomName;
        confirmedRoomName.textContent = roomName;
        
        // Switch to step 2
        purchaseStep1.classList.remove('active');
        purchaseStep2.classList.add('active');
      } else {
        nameCheckResult.className = 'name-check-result taken';
        
        if (data.isFoundation) {
          nameCheckResult.textContent = `✗ "${roomName}" is already a Foundation Room.`;
        } else {
          nameCheckResult.textContent = `✗ "${roomName}" is not available.`;
        }
      }
    } catch (err) {
      console.error('Check error:', err);
      nameCheckResult.className = 'name-check-result taken';
      nameCheckResult.textContent = '✗ Error checking availability. Please try again.';
    }
  });
}

// NEW: Back to step 1
if (backToStep1Btn) {
  backToStep1Btn.addEventListener('click', () => {
    purchaseStep2.classList.remove('active');
    purchaseStep1.classList.add('active');
    selectedRoomName = '';
    purchaseForm.reset();
  });
}

// NEW: Purchase form
if (purchaseForm) {
  purchaseForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const password = $('purchasePassword').value;
    const passwordConfirm = $('purchasePasswordConfirm').value;
    const email = $('purchaseEmail').value.trim();

    if (password !== passwordConfirm) {
      setStatus(purchaseStatus, 'Passwords do not match', 'error');
      return;
    }

    if (password.length < 8) {
      setStatus(purchaseStatus, 'Password must be at least 8 characters', 'error');
      return;
    }

    setStatus(purchaseStatus, 'Creating secure checkout session...', '');

    try {
      const response = await fetch('/api/foundation/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: selectedRoomName,
          password: password,
          email: email
        })
      });

      const data = await response.json();

      if (data.success && data.url) {
        setStatus(purchaseStatus, 'Redirecting to Stripe Checkout...', 'ok');
        window.location.href = data.url;
      } else {
        setStatus(purchaseStatus, data.error || 'Purchase failed', 'error');
      }
    } catch (err) {
      console.error('Purchase error:', err);
      setStatus(purchaseStatus, 'Network error. Please try again.', 'error');
    }
  });
}

if (refreshRoomsBtn) {
  refreshRoomsBtn.onclick = requestPublicRooms;
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
    socket.emit('enter-host-room', { roomName: name, password }, response => {
      if (response?.ok) {
        if (password) sessionStorage.setItem(`hostPassword:${name}`, password);
        
        if (response.isFoundationRoom) {
          setStatus(hostRoomStatus, 'Foundation Room verified! Redirecting...', 'ok');
        } else {
          setStatus(hostRoomStatus, 'Entering studio...', 'ok');
        }
        
        setTimeout(() => {
          window.location.href = `/index.html?room=${encodeURIComponent(name)}&role=host`;
        }, 1000);
      } else {
        setStatus(hostRoomStatus, response?.error || 'Unable to enter host studio.', 'error');
      }
    });
  });
}

requestPublicRooms();

// NEW: Load initial foundation status
fetch('/api/foundation/status')
  .then(res => res.json())
  .then(updateFoundationStats)
  .catch(err => console.error('Failed to load foundation status:', err));

// NEW: Handle purchase success redirect
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('session_id');
const purchasedRoom = urlParams.get('room');

if (sessionId && purchasedRoom) {
  const successBanner = document.createElement('div');
  successBanner.className = 'foundation-banner';
  successBanner.style.background = 'linear-gradient(135deg, #4af3a3, #2ecc71)';
  successBanner.innerHTML = `
    <h2>🎉 Purchase Successful!</h2>
    <p>Congratulations! You now own the Foundation Room: <strong>"${purchasedRoom}"</strong></p>
    <p>Your confirmation email is on its way.</p>
    <button class="btn primary" onclick="window.location.href='/index.html?room=${encodeURIComponent(purchasedRoom)}&role=host'" style="margin-top: 15px;">
      Enter Your Studio Now
    </button>
  `;
  
  const landingGrid = document.querySelector('.landing-grid');
  if (landingGrid) {
    landingGrid.insertAdjacentElement('beforebegin', successBanner);
  }
  
  window.history.replaceState({}, document.title, '/');
}
