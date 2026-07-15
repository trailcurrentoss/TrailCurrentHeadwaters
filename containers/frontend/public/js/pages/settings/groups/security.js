// Settings > Security
// Change Password — extracted verbatim from settings.js.

import { API } from '../../../api.js';

export const securityGroup = {
    meta: {
        id: 'security',
        title: 'Security',
        icon: 'lock-closed-outline',
        sub: 'Account password',
    },
    searchIndex: [
        { label: 'Change Password', kw: 'password change account admin credentials current new confirm',
          anchor: 'change-password-form' },
    ],

    render() {
        const user = API.getUser();
        return `
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Change Password</span>
                    <p class="settings-description">Update your account password (${escapeHtml(user?.username || 'user')})</p>
                </div>
                <form id="change-password-form" class="password-form">
                    <div class="password-form-group">
                        <label for="current-password" class="password-label">Current Password</label>
                        <input type="password" id="current-password" class="password-input"
                               placeholder="Enter current password" autocomplete="current-password" required>
                    </div>
                    <div class="password-form-group">
                        <label for="new-password" class="password-label">New Password</label>
                        <input type="password" id="new-password" class="password-input"
                               placeholder="Enter new password (min 6 chars)" autocomplete="new-password" required minlength="6">
                    </div>
                    <div class="password-form-group">
                        <label for="confirm-password" class="password-label">Confirm New Password</label>
                        <input type="password" id="confirm-password" class="password-input"
                               placeholder="Confirm new password" autocomplete="new-password" required>
                    </div>
                    <div id="password-message" class="password-message hidden"></div>
                    <button type="submit" class="password-submit-btn" id="password-submit-btn">
                        Change Password
                    </button>
                </form>
            </div>
        `;
    },

    init() {
        const passwordForm = document.getElementById('change-password-form');
        if (passwordForm) {
            passwordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                await handleChangePassword();
            });
        }
    },

    cleanup() {
        // Listeners attach to elements that are removed with the mount swap.
    },
};

async function handleChangePassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const messageEl = document.getElementById('password-message');
    const submitBtn = document.getElementById('password-submit-btn');

    messageEl.classList.add('hidden');
    messageEl.classList.remove('success', 'error');

    if (newPassword !== confirmPassword) {
        showPasswordMessage('New passwords do not match', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showPasswordMessage('New password must be at least 6 characters', 'error');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Changing...';

    try {
        await API.changePassword(currentPassword, newPassword);
        showPasswordMessage('Password changed successfully', 'success');

        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
    } catch (error) {
        showPasswordMessage(error.message || 'Failed to change password', 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Password';
    }
}

function showPasswordMessage(message, type) {
    const messageEl = document.getElementById('password-message');
    if (messageEl) {
        messageEl.textContent = message;
        messageEl.classList.remove('hidden', 'success', 'error');
        messageEl.classList.add(type);
    }
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
