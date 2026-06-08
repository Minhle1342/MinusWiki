/* ==========================================================================
   MinusWiki SPA Frontend Controller (Modular Architecture with PubSub)
   ========================================================================== */

// Global Application Core State & PubSub Event Emitter
const app = {
  state: {
    currentProjectId: null,
    currentWikiFilename: null,
    projectsList: [],
    activeTab: 'pages' // 'pages', 'sources', 'logs'
  },
  
  events: {
    listeners: {},
    on(event, callback) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(callback);
    },
    off(event, callback) {
      if (!this.listeners[event]) return;
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    },
    emit(event, data) {
      if (!this.listeners[event]) return;
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err);
        }
      });
    }
  },

  // Toast System
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle';
    if (type === 'warning') iconName = 'alert-triangle';
    if (type === 'error') iconName = 'alert-octagon';

    toast.innerHTML = `
      <i data-lucide="${iconName}"></i>
      <div class="toast-text">${message}</div>
    `;

    container.appendChild(toast);
    lucide.createIcons();

    // Allow clicking the toast to dismiss it instantly
    let isDismissed = false;
    const dismiss = () => {
      if (isDismissed) return;
      isDismissed = true;
      toast.style.animation = 'toastExit 0.3s forwards';
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    };

    toast.addEventListener('click', dismiss);

    // Remove toast automatically after 4 seconds
    setTimeout(dismiss, 4000);
  },

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

// ==========================================
// 1. PROJECT SWITCHER & CONFIG MODULE
// ==========================================
const ProjectManager = {
  init() {
    this.selectEl = document.getElementById('project-select');
    this.createTriggerBtn = document.getElementById('btn-create-project-trigger');
    this.deleteBtn = document.getElementById('btn-delete-project');
    
    this.modalOverlay = document.getElementById('create-project-modal');
    this.modalCloseBtn = document.getElementById('btn-close-modal');
    this.modalForm = document.getElementById('create-project-form');
    this.modalCancelBtn = document.getElementById('btn-cancel-project');
    
    // Bind UI actions
    this.selectEl.addEventListener('change', (e) => this.handleProjectSwitch(e.target.value));
    this.createTriggerBtn.addEventListener('click', () => this.showModal(true));
    this.modalCloseBtn.addEventListener('click', () => this.showModal(false));
    this.modalCancelBtn.addEventListener('click', () => this.showModal(false));
    this.deleteBtn.addEventListener('click', () => this.handleDeleteProject());
    
    this.modalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = document.getElementById('project-title-input').value.trim();
      if (title) this.createNewProject(title);
    });

    // Subscriptions
    app.events.on('project:list-updated', (list) => this.renderProjectDropdown(list));
    
    // Load initial projects
    this.loadProjects();
  },

  showModal(show) {
    if (show) {
      this.modalOverlay.classList.remove('hidden');
      document.getElementById('project-title-input').focus();
    } else {
      this.modalOverlay.classList.add('hidden');
      this.modalForm.reset();
    }
  },

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      if (!res.ok) throw new Error('Failed to fetch projects');
      const projects = await res.json();
      app.state.projectsList = projects;
      
      app.events.emit('project:list-updated', projects);
      
      // Auto-select first project or prompt to create one
      if (projects.length > 0) {
        // Try to read last saved project or choose the first one
        const lastProjId = localStorage.getItem('minuswiki_current_project');
        const projExists = projects.some(p => p.id === lastProjId);
        const activeId = projExists ? lastProjId : projects[0].id;
        this.handleProjectSwitch(activeId);
      } else {
        // Empty state - auto open modal
        this.showModal(true);
      }
    } catch (err) {
      console.error(err);
      app.showToast('Không thể tải danh sách dự án.', 'error');
    }
  },

  renderProjectDropdown(projects) {
    this.selectEl.innerHTML = '';
    if (projects.length === 0) {
      this.selectEl.innerHTML = '<option value="" disabled selected>Không có dự án nào</option>';
      return;
    }
    
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.title;
      opt.selected = p.id === app.state.currentProjectId;
      this.selectEl.appendChild(opt);
    });
  },

  handleProjectSwitch(projectId) {
    if (app.state.currentProjectId === projectId) return;
    app.state.currentProjectId = projectId;
    localStorage.setItem('minuswiki_current_project', projectId);
    
    // Update select UI
    this.selectEl.value = projectId;
    
    // Reset page view
    app.state.currentWikiFilename = null;
    
    app.showToast('Đã chuyển sang dự án mới', 'info');
    app.events.emit('project:changed', projectId);
  },

  async createNewProject(title) {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      if (!res.ok) throw new Error('Create project failed');
      const newProj = await res.json();
      
      app.showToast(`Đã tạo dự án "${title}" thành công!`, 'success');
      this.showModal(false);
      
      // Reload projects and switch to new one
      app.state.currentProjectId = newProj.id;
      await this.loadProjects();
    } catch (err) {
      console.error(err);
      app.showToast('Không thể tạo dự án mới.', 'error');
    }
  },

  async handleDeleteProject() {
    const currentId = app.state.currentProjectId;
    if (!currentId) return;
    
    const proj = app.state.projectsList.find(p => p.id === currentId);
    const title = proj ? proj.title : 'dự án';
    
    if (!confirm(`Bạn có chắc chắn muốn XÓA TOÀN BỘ dự án "${title}"?\nHành động này không thể hoàn tác!`)) {
      return;
    }

    try {
      const res = await fetch(`/api/projects/${currentId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete project failed');
      
      app.showToast(`Đã xóa dự án "${title}"`, 'warning');
      app.state.currentProjectId = null;
      localStorage.removeItem('minuswiki_current_project');
      
      // Reload projects list
      await this.loadProjects();
    } catch (err) {
      console.error(err);
      app.showToast('Xóa dự án thất bại.', 'error');
    }
  }
};

// ==========================================
// 1.5. SETTINGS & CONFIGURATION MODULE
// ==========================================
const SettingsManager = {
  init() {
    this.triggerBtn = document.getElementById('btn-settings-trigger');
    this.modal = document.getElementById('settings-modal');
    this.closeBtn = document.getElementById('btn-close-settings-modal');
    this.cancelBtn = document.getElementById('btn-cancel-settings');
    this.form = document.getElementById('settings-form');
    
    this.providerSelect = document.getElementById('settings-provider');
    this.geminiFields = document.getElementById('settings-gemini-fields');
    this.openaiFields = document.getElementById('settings-openai-fields');
    
    this.geminiKeyInput = document.getElementById('settings-gemini-key');
    this.geminiModelInput = document.getElementById('settings-gemini-model');
    this.openaiKeyInput = document.getElementById('settings-openai-key');
    this.openaiModelInput = document.getElementById('settings-openai-model');
    this.openaiBaseInput = document.getElementById('settings-openai-base');

    this.googleKeyInput = document.getElementById('settings-google-key');
    this.googleClientInput = document.getElementById('settings-google-client');
    
    if (this.triggerBtn) {
      this.triggerBtn.addEventListener('click', () => this.openModal());
    }
    
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.modal.classList.add('hidden'));
    }
    if (this.cancelBtn) {
      this.cancelBtn.addEventListener('click', () => this.modal.classList.add('hidden'));
    }
    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.modal.classList.add('hidden');
      });
    }
    
    if (this.providerSelect) {
      this.providerSelect.addEventListener('change', () => this.toggleProviderFields());
    }
    
    if (this.form) {
      this.form.addEventListener('submit', (e) => this.handleSave(e));
    }

    // Check configuration status on load
    this.checkFirstTime();
  },
  
  async checkFirstTime() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const config = await res.json();
        if (!config.GEMINI_API_KEY && !config.OPENAI_API_KEY) {
          setTimeout(() => {
            this.openModal();
            app.showToast('Vui lòng cấu hình API Key trước khi bắt đầu!', 'info');
          }, 800);
        }
      }
    } catch (err) {
      console.error('Failed to auto check config:', err);
    }
  },
  
  async openModal() {
    if (!this.modal) return;
    this.modal.classList.remove('hidden');
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const config = await res.json();
        
        if (this.providerSelect) this.providerSelect.value = config.LLM_PROVIDER || 'gemini';
        if (this.geminiKeyInput) this.geminiKeyInput.value = config.GEMINI_API_KEY || '';
        if (this.geminiModelInput) this.geminiModelInput.value = config.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
        if (this.openaiKeyInput) this.openaiKeyInput.value = config.OPENAI_API_KEY || '';
        if (this.openaiModelInput) this.openaiModelInput.value = config.OPENAI_MODEL || 'DeepSeek-V4-Flash';
        if (this.openaiBaseInput) this.openaiBaseInput.value = config.OPENAI_API_BASE || 'https://api.deepseek.com';
        if (this.googleKeyInput) this.googleKeyInput.value = config.GOOGLE_API_KEY || '';
        if (this.googleClientInput) this.googleClientInput.value = config.GOOGLE_CLIENT_ID || '';
        
        this.toggleProviderFields();
      }
    } catch (err) {
      console.error('Failed to fetch config:', err);
      app.showToast('Không thể tải cấu hình hiện tại.', 'error');
    }
  },
  
  toggleProviderFields() {
    if (!this.providerSelect) return;
    const val = this.providerSelect.value;
    if (val === 'gemini') {
      if (this.geminiFields) this.geminiFields.classList.remove('hidden');
      if (this.openaiFields) this.openaiFields.classList.add('hidden');
    } else {
      if (this.geminiFields) this.geminiFields.classList.add('hidden');
      if (this.openaiFields) this.openaiFields.classList.remove('hidden');
    }
  },
  
  async handleSave(e) {
    e.preventDefault();
    const data = {
      LLM_PROVIDER: this.providerSelect ? this.providerSelect.value : 'gemini',
      GEMINI_API_KEY: this.geminiKeyInput ? this.geminiKeyInput.value.trim() : '',
      GEMINI_MODEL: this.geminiModelInput ? this.geminiModelInput.value.trim() : '',
      OPENAI_API_KEY: this.openaiKeyInput ? this.openaiKeyInput.value.trim() : '',
      OPENAI_MODEL: this.openaiModelInput ? this.openaiModelInput.value.trim() : '',
      OPENAI_API_BASE: this.openaiBaseInput ? this.openaiBaseInput.value.trim() : '',
      GOOGLE_API_KEY: this.googleKeyInput ? this.googleKeyInput.value.trim() : '',
      GOOGLE_CLIENT_ID: this.googleClientInput ? this.googleClientInput.value.trim() : ''
    };
    
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      
      if (!res.ok) throw new Error('Save configuration request failed');
      const result = await res.json();
      
      app.showToast(result.message || 'Lưu cấu hình thành công!', 'success');
      this.modal.classList.add('hidden');
    } catch (err) {
      console.error(err);
      app.showToast('Lưu cấu hình thất bại.', 'error');
    }
  }
};

// ==========================================
// 1.7. GOOGLE DRIVE IMPORT MODULE
// ==========================================
const GoogleDriveManager = {
  isErrorState: false,

  init() {
    this.triggerBtn = document.getElementById('google-drive-trigger-btn');
    this.modal = document.getElementById('google-drive-modal');
    this.closeBtn = document.getElementById('btn-close-google-modal');
    
    this.shareLinkInput = document.getElementById('google-share-link');
    this.importLinkBtn = document.getElementById('btn-import-google-link');
    this.openPickerBtn = document.getElementById('btn-open-google-picker');
    
    if (this.triggerBtn) {
      this.triggerBtn.addEventListener('click', () => this.openModal());
    }
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.modal.classList.add('hidden'));
    }
    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.modal.classList.add('hidden');
      });
    }
    
    if (this.importLinkBtn) {
      this.importLinkBtn.addEventListener('click', () => this.handleLinkImport());
    }
    if (this.openPickerBtn) {
      this.openPickerBtn.addEventListener('click', () => this.handlePickerOpen());
    }
  },
  
  showErrorState(message) {
    if (!this.triggerBtn) return;
    if (this.isErrorState) return;
    this.isErrorState = true;
    
    const originalStyle = this.triggerBtn.getAttribute('style') || '';
    const originalHTML = this.triggerBtn.innerHTML;
    
    // Apply error styles
    this.triggerBtn.style.background = 'rgba(239, 68, 68, 0.15)';
    this.triggerBtn.style.color = '#ef4444';
    this.triggerBtn.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    this.triggerBtn.setAttribute('title', message || 'Lỗi khi nạp từ Google Drive');
    
    const span = this.triggerBtn.querySelector('span');
    if (span) {
      span.textContent = 'Lỗi nạp Drive!';
    }
    
    // Simple shake animation
    let shakeCount = 0;
    const shakeInterval = setInterval(() => {
      this.triggerBtn.style.transform = shakeCount % 2 === 0 ? 'translateX(-4px)' : 'translateX(4px)';
      shakeCount++;
      if (shakeCount >= 6) {
        clearInterval(shakeInterval);
        this.triggerBtn.style.transform = '';
      }
    }, 80);
    
    // Revert styling after 4 seconds
    setTimeout(() => {
      this.triggerBtn.setAttribute('style', originalStyle);
      this.triggerBtn.innerHTML = originalHTML;
      this.triggerBtn.removeAttribute('title');
      this.isErrorState = false;
    }, 4000);
  },
  
  openModal() {
    if (!app.state.currentProjectId) {
      app.showToast('Vui lòng chọn hoặc tạo dự án trước khi nạp tài liệu!', 'warning');
      this.showErrorState('Chưa chọn hoặc tạo dự án!');
      return;
    }
    this.modal.classList.remove('hidden');
    if (this.shareLinkInput) {
      this.shareLinkInput.value = '';
    }
  },
  
  async handleLinkImport() {
    const url = this.shareLinkInput.value.trim();
    if (!url) {
      app.showToast('Vui lòng nhập đường dẫn Google Drive!', 'warning');
      return;
    }
    
    const projId = app.state.currentProjectId;
    this.modal.classList.add('hidden');
    
    // Switch to sources tab and show upload progress
    WikiTreeManager.switchSidebarTab('tab-sources');
    WikiTreeManager.progressWrapper.classList.remove('hidden');
    WikiTreeManager.progressBar.style.width = '20%';
    WikiTreeManager.progressPercent.textContent = '20%';
    WikiTreeManager.progressText.textContent = 'Đang tải tệp từ liên kết Google Drive...';
    
    try {
      const res = await fetch(`/api/projects/${projId}/upload/google-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Nhập từ Google Drive thất bại');
      }
      
      const data = await res.json();
      WikiTreeManager.progressBar.style.width = '100%';
      WikiTreeManager.progressPercent.textContent = '100%';
      WikiTreeManager.progressText.textContent = 'Hoàn thành nạp tri thức!';
      
      app.showToast(data.message || 'Đã nạp tài liệu thành công!', 'success');
      WikiTreeManager.refreshWorkspace(projId);
      app.events.emit('source:uploaded');
    } catch (err) {
      console.error(err);
      app.showToast(`Lỗi khi nạp từ Google Drive: ${err.message}`, 'error');
      this.showErrorState(err.message);
    } finally {
      setTimeout(() => {
        WikiTreeManager.progressWrapper.classList.add('hidden');
      }, 3000);
    }
  },
  
  async handlePickerOpen() {
    try {
      const configRes = await fetch('/api/config');
      if (!configRes.ok) throw new Error('Không thể tải cấu hình API');
      const config = await configRes.json();
      
      const apiKey = config.GOOGLE_API_KEY;
      const clientId = config.GOOGLE_CLIENT_ID;
      
      if (!apiKey || !clientId) {
        app.showToast('Vui lòng cấu hình Google API Key và Client ID trong mục Cài đặt trước.', 'warning');
        this.showErrorState('Thiếu cấu hình Google API Key/Client ID');
        return;
      }
      
      this.modal.classList.add('hidden');
      
      // Request access token using GIS
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: async (response) => {
          if (response.error !== undefined) {
            console.error('GIS Error:', response);
            app.showToast('Không thể xác thực tài khoản Google.', 'error');
            this.showErrorState('Lỗi xác thực Google');
            return;
          }
          const accessToken = response.access_token;
          this.openPicker(accessToken, apiKey, clientId);
        },
      });
      tokenClient.requestAccessToken({ prompt: 'consent' });
      
    } catch (err) {
      console.error(err);
      app.showToast(`Không thể khởi chạy Google Picker: ${err.message}`, 'error');
      this.showErrorState(err.message);
    }
  },
  
  openPicker(accessToken, apiKey, clientId) {
    gapi.load('picker', () => {
      try {
        const view = new google.picker.DocsView()
          .setIncludeFolders(true)
          .setMimeTypes([
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.google-apps.document',
            'application/vnd.google-apps.spreadsheet',
            'application/vnd.google-apps.presentation',
            'text/plain',
            'text/markdown'
          ].join(','));
          
        const picker = new google.picker.PickerBuilder()
          .enableFeature(google.picker.Feature.NAV_HIDDEN)
          .setDeveloperKey(apiKey)
          .setAppId(clientId)
          .setOAuthToken(accessToken)
          .addView(view)
          .setCallback(async (data) => {
            if (data[google.picker.Response.ACTION] === google.picker.Action.PICKED) {
              const docs = data[google.picker.Response.DOCUMENTS];
              if (docs && docs.length > 0) {
                const doc = docs[0];
                await this.importPickerFile(doc, accessToken);
              }
            }
          })
          .build();
        picker.setVisible(true);
      } catch (err) {
        console.error('Lỗi khi mở Picker:', err);
        app.showToast('Không thể hiển thị Google Drive Picker.', 'error');
        this.showErrorState(err.message || 'Lỗi hiển thị Picker');
      }
    });
  },
  
  async importPickerFile(doc, accessToken) {
    const projId = app.state.currentProjectId;
    const fileId = doc[google.picker.Document.ID];
    const name = doc[google.picker.Document.NAME];
    const mimeType = doc[google.picker.Document.MIME_TYPE];
    
    // Switch to sources tab and show upload progress
    WikiTreeManager.switchSidebarTab('tab-sources');
    WikiTreeManager.progressWrapper.classList.remove('hidden');
    WikiTreeManager.progressBar.style.width = '30%';
    WikiTreeManager.progressPercent.textContent = '30%';
    WikiTreeManager.progressText.textContent = `Đang tải tệp "${name}" từ Google Drive...`;
    
    try {
      const res = await fetch(`/api/projects/${projId}/upload/google-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, name, mimeType, accessToken })
      });
      
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Nạp tệp thất bại');
      }
      
      const data = await res.json();
      WikiTreeManager.progressBar.style.width = '100%';
      WikiTreeManager.progressPercent.textContent = '100%';
      WikiTreeManager.progressText.textContent = 'Hoàn thành nạp tri thức!';
      
      app.showToast(data.message || 'Nạp tệp thành công!', 'success');
      WikiTreeManager.refreshWorkspace(projId);
      app.events.emit('source:uploaded');
    } catch (err) {
      console.error(err);
      app.showToast(`Lỗi khi nạp tệp từ Google Drive: ${err.message}`, 'error');
      this.showErrorState(err.message);
    } finally {
      setTimeout(() => {
        WikiTreeManager.progressWrapper.classList.add('hidden');
      }, 3000);
    }
  }
};

// ==========================================
// 2. WIKI PAGES & DOCUMENTS SIDEBAR MODULE
// ==========================================
const WikiTreeManager = {
  init() {
    this.pagesListEl = document.getElementById('wiki-page-list');
    this.sourcesListEl = document.getElementById('sources-list');
    this.queueListEl = document.getElementById('queue-list');
    this.logsContentEl = document.getElementById('logs-content');
    this.searchInput = document.getElementById('wiki-search');
    
    // Upload elements
    this.uploadZone = document.getElementById('upload-zone');
    this.fileInput = document.getElementById('file-input');
    this.progressWrapper = document.getElementById('upload-progress-wrapper');
    this.progressBar = document.getElementById('upload-progress-bar');
    this.progressText = document.getElementById('upload-progress-text');
    this.progressPercent = document.getElementById('upload-progress-percent');
    
    // Page Content Panel elements
    this.noPageEl = document.getElementById('no-page-selected');
    this.pageViewEl = document.getElementById('wiki-page-view');
    this.pageTitleEl = document.getElementById('wiki-page-title');
    this.pageFilenameEl = document.getElementById('wiki-page-filename');
    
    this.readerEl = document.getElementById('wiki-reader');
    this.editorContainer = document.getElementById('wiki-editor');
    this.markdownTextarea = document.getElementById('markdown-textarea');
    
    // Toolbar buttons
    this.editBtn = document.getElementById('btn-edit-page');
    this.deletePageBtn = document.getElementById('btn-delete-page');
    this.saveBtn = document.getElementById('btn-save-page');
    this.cancelBtn = document.getElementById('btn-cancel-edit');
    this.toggleMpeBtn = document.getElementById('btn-toggle-mpe');
    
    // Sidebar Tabs
    this.tabButtons = document.querySelectorAll('.tab-btn');
    this.tabPanes = document.querySelectorAll('.sidebar-tab-content .tab-pane');

    // Maintenance elements
    this.runMaintenanceBtn = document.getElementById('btn-run-maintenance');
    this.orphanPagesList = document.getElementById('orphan-pages-list');
    this.autoLinkAllBtn = document.getElementById('auto-link-all-btn');
    this.gapsList = document.getElementById('gaps-list');
    this.contradictionsList = document.getElementById('contradictions-list');
    this.autoMaintenanceChk = document.getElementById('chk-auto-maintenance');

    // Bind event handlers
    this.searchInput.addEventListener('input', () => this.filterPagesList());
    
    // Upload triggers
    this.uploadZone.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (e) => this.handleFileSelection(e.target.files));
    
    // Setup drag and drop
    this.uploadZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.uploadZone.classList.add('dragover');
    });
    this.uploadZone.addEventListener('dragleave', () => {
      this.uploadZone.classList.remove('dragover');
    });
    this.uploadZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.uploadZone.classList.remove('dragover');
      this.handleFileSelection(e.dataTransfer.files);
    });
    
    // Page actions
    this.editBtn.addEventListener('click', () => this.toggleEditorMode(true));
    this.cancelBtn.addEventListener('click', () => this.toggleEditorMode(false));
    this.saveBtn.addEventListener('click', () => this.saveWikiPage());
    this.deletePageBtn.addEventListener('click', () => this.deleteWikiPage());
    
    this.mpeMode = localStorage.getItem('minuswiki_mpe_mode') === 'true';
    this.updateMpeUI();
    this.toggleMpeBtn.addEventListener('click', () => {
      this.mpeMode = !this.mpeMode;
      localStorage.setItem('minuswiki_mpe_mode', this.mpeMode);
      this.updateMpeUI();
    });

    this.autoMaintenanceMode = localStorage.getItem('minuswiki_auto_maintenance') === 'true';
    if (this.autoMaintenanceChk) {
      this.autoMaintenanceChk.checked = this.autoMaintenanceMode;
      this.autoMaintenanceChk.addEventListener('change', (e) => {
        this.autoMaintenanceMode = e.target.checked;
        localStorage.setItem('minuswiki_auto_maintenance', this.autoMaintenanceMode);
      });
    }

    if (this.runMaintenanceBtn) {
      this.runMaintenanceBtn.addEventListener('click', () => this.runWikiMaintenance());
    }
    if (this.autoLinkAllBtn) {
      this.autoLinkAllBtn.addEventListener('click', () => this.autoLinkAllOrphans());
    }
    
    // Sidebar Tabs navigation
    this.tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        this.switchSidebarTab(target);
      });
    });

    // Subscriptions
    app.events.on('project:changed', (projId) => this.refreshWorkspace(projId));
    app.events.on('wiki:page-selected', (filename) => this.loadWikiPage(filename));
    app.events.on('source:uploaded', () => {
      if (this.autoMaintenanceMode) {
        this.runWikiMaintenance(true);
      }
    });

    // Start polling the ingest queue
    this.startQueuePolling();
  },

  switchSidebarTab(targetTabId) {
    this.tabButtons.forEach(b => b.classList.toggle('active', b.dataset.target === targetTabId));
    this.tabPanes.forEach(pane => pane.classList.toggle('active', pane.id === targetTabId));
    
    // Fetch logs specifically if selected logs tab
    if (targetTabId === 'tab-logs' && app.state.currentProjectId) {
      this.fetchLogs();
    }
  },

  async refreshWorkspace(projectId) {
    if (!projectId) return;
    this.showPageSelectionPrompt(true);
    
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error('Failed to load project files');
      const data = await res.json();
      
      this.renderPagesList(data.pages);
      this.renderSourcesList(data.sources);
      this.fetchQueue();
      
      // Select overview.md by default if it exists and no page is currently active
      if (!app.state.currentWikiFilename) {
        const hasOverview = data.pages.some(p => p.filename === 'overview.md');
        if (hasOverview) {
          this.loadWikiPage('overview.md');
        }
      }

      // Automatically run silent maintenance scan if auto maintenance mode is enabled
      if (this.autoMaintenanceMode) {
        this.runWikiMaintenance(true);
      }
    } catch (err) {
      console.error(err);
      app.showToast('Lỗi khi tải tri thức dự án.', 'error');
    }
  },

  renderPagesList(pages) {
    this.pagesListEl.innerHTML = '';
    
    if (!pages || pages.length === 0) {
      this.pagesListEl.innerHTML = `
        <li class="empty-state">
          <i data-lucide="folder-open"></i>
          <p>Chưa có trang tri thức nào. Hãy nạp tài liệu để bắt đầu!</p>
        </li>
      `;
      lucide.createIcons();
      return;
    }
    
    // Sort pages: index.md first, overview.md second, log.md third, others alphabetically
    const sorted = [...pages].sort((a, b) => {
      const nameA = a.filename;
      const nameB = b.filename;
      if (nameA === 'index.md') return -1;
      if (nameB === 'index.md') return 1;
      if (nameA === 'overview.md') return -1;
      if (nameB === 'overview.md') return 1;
      if (nameA === 'log.md') return -1;
      if (nameB === 'log.md') return 1;
      return nameA.localeCompare(nameB);
    });

    sorted.forEach(page => {
      const li = document.createElement('li');
      li.className = `wiki-item ${app.state.currentWikiFilename === page.filename ? 'active' : ''}`;
      li.dataset.filename = page.filename;
      li.setAttribute('draggable', 'true');
      
      let icon = 'file-text';
      if (page.filename === 'index.md') icon = 'book-open';
      if (page.filename === 'overview.md') icon = 'home';
      if (page.filename === 'log.md') icon = 'history';
 
      // Format timestamp nicely
      const dateStr = new Date(page.updatedAt).toLocaleDateString('vi-VN', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
 
      const titleClass = page.hasContradiction ? 'wiki-item-title has-contradiction' : 'wiki-item-title';
      li.innerHTML = `
        <span class="${titleClass}">
          <i data-lucide="${icon}"></i>
          <span>${page.title}</span>
        </span>
        <span class="wiki-item-meta">${dateStr}</span>
      `;
      
      li.addEventListener('click', () => {
        app.events.emit('wiki:page-selected', page.filename);
      });

      li.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', page.filename);
        e.dataTransfer.setData('application/json', JSON.stringify({ filename: page.filename, title: page.title }));
        e.dataTransfer.effectAllowed = 'copyMove';
      });
      
      this.pagesListEl.appendChild(li);
    });
    
    lucide.createIcons();
  },

  filterPagesList() {
    const q = this.searchInput.value.toLowerCase().trim();
    const items = this.pagesListEl.querySelectorAll('.wiki-item');
    
    items.forEach(item => {
      const text = item.querySelector('.wiki-item-title span').textContent.toLowerCase();
      const filename = item.dataset.filename.toLowerCase();
      const matches = text.includes(q) || filename.includes(q);
      item.classList.toggle('hidden', !matches);
    });
  },

  renderSourcesList(sources) {
    this.sourcesListEl.innerHTML = '';
    
    if (!sources || sources.length === 0) {
      this.sourcesListEl.innerHTML = `
        <li class="empty-state">
          <i data-lucide="file-text"></i>
          <p>Chưa có tài liệu nguồn nào được tải lên.</p>
        </li>
      `;
      lucide.createIcons();
      return;
    }
    
    sources.forEach(src => {
      const li = document.createElement('li');
      li.className = 'source-item';
      
      let icon = 'file';
      const ext = src.split('.').pop().toLowerCase();
      if (ext === 'pdf') icon = 'file-text';
      if (ext === 'docx') icon = 'file-text';
      if (ext === 'xlsx' || ext === 'xls') icon = 'file-spreadsheet';
      if (ext === 'txt' || ext === 'md') icon = 'file-text';

      li.innerHTML = `
        <div class="source-item-info">
          <i data-lucide="${icon}"></i>
          <span class="source-name" title="${src}">${src}</span>
        </div>
        <button class="btn-delete-source" title="Xóa tài liệu và các trang liên quan">
          <i data-lucide="trash-2"></i>
        </button>
      `;

      // Bind delete handler
      const deleteBtn = li.querySelector('.btn-delete-source');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Bạn có chắc chắn muốn xóa tài liệu nguồn "${src}"? Các trang tri thức chỉ được tạo ra từ tài liệu này cũng sẽ bị xóa (Cascade Delete).`)) {
          try {
            const res = await fetch(`/api/projects/${app.state.currentProjectId}/sources/${encodeURIComponent(src)}`, {
              method: 'DELETE'
            });
            if (!res.ok) throw new Error('Delete source failed');
            app.showToast(`Đã xóa tài liệu nguồn "${src}"`, 'warning');
            
            // Reload workspace
            this.refreshWorkspace(app.state.currentProjectId);
            app.events.emit('source:uploaded'); // refreshes graph
          } catch (err) {
            console.error(err);
            app.showToast('Xóa tài liệu nguồn thất bại.', 'error');
          }
        }
      });
      
      this.sourcesListEl.appendChild(li);
    });
    
    lucide.createIcons();
  },

  async fetchQueue() {
    const projId = app.state.currentProjectId;
    if (!projId) return;

    try {
      const res = await fetch(`/api/projects/${projId}/queue`);
      if (!res.ok) throw new Error('Failed to fetch queue');
      const queueTasks = await res.json();
      this.renderQueueList(queueTasks);
      
      // Check if queue just finished processing
      const hasActiveTasks = queueTasks.some(t => t.status === 'pending' || t.status === 'processing');
      if (this.hadActiveTasks && !hasActiveTasks) {
        // Queue just finished processing! Reload pages list to show new wiki articles
        const projRes = await fetch(`/api/projects/${projId}`);
        if (projRes.ok) {
          const data = await projRes.json();
          this.renderPagesList(data.pages);
          this.renderSourcesList(data.sources);
          app.events.emit('source:uploaded'); // refreshes graph
        }
      }
      this.hadActiveTasks = hasActiveTasks;
    } catch (err) {
      console.error('Error fetching queue:', err);
    }
  },

  renderQueueList(tasks) {
    this.queueListEl.innerHTML = '';

    if (!tasks || tasks.length === 0) {
      this.queueListEl.innerHTML = `
        <li class="empty-state">
          <i data-lucide="clock"></i>
          <p>Không có tệp nào đang xếp hàng hoặc xử lý.</p>
        </li>
      `;
      lucide.createIcons();
      return;
    }

    tasks.forEach(task => {
      const li = document.createElement('li');
      li.className = 'source-item';
      
      let statusText = 'Đang chờ';
      let statusClass = 'queue-status-pending';
      if (task.status === 'processing') {
        statusText = 'Đang xử lý';
        statusClass = 'queue-status-processing';
      } else if (task.status === 'completed') {
        statusText = 'Hoàn thành';
        statusClass = 'queue-status-completed';
      } else if (task.status === 'failed') {
        statusText = 'Thất bại';
        statusClass = 'queue-status-failed';
      }

      li.innerHTML = `
        <div class="source-item-info">
          <i data-lucide="clock"></i>
          <span class="source-name" title="${task.filename}">${task.filename}</span>
        </div>
        <div class="queue-status-wrapper">
          <span class="queue-status ${statusClass}" title="${task.error || ''}">${statusText}</span>
          ${task.status === 'failed' ? `
            <button class="btn-retry-task" title="Thử lại ngay lập tức">
              <i data-lucide="refresh-cw"></i>
            </button>
          ` : ''}
        </div>
      `;

      if (task.status === 'failed') {
        const retryBtn = li.querySelector('.btn-retry-task');
        retryBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const res = await fetch(`/api/projects/${app.state.currentProjectId}/queue/retry`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId: task.id })
            });
            if (!res.ok) throw new Error('Retry failed');
            app.showToast('Đang tiến hành thử lại nạp tài liệu...', 'info');
            this.fetchQueue();
          } catch (err) {
            console.error(err);
            app.showToast('Gửi yêu cầu thử lại thất bại.', 'error');
          }
        });
      }

      this.queueListEl.appendChild(li);
    });

    lucide.createIcons();
  },

  startQueuePolling() {
    setInterval(() => {
      if (app.state.currentProjectId) {
        this.fetchQueue();
      }
    }, 3000);
  },

  async fetchLogs() {
    if (!app.state.currentProjectId) return;
    try {
      const res = await fetch(`/api/projects/${app.state.currentProjectId}/logs`);
      if (!res.ok) throw new Error('Logs not found');
      const data = await res.json();
      this.logsContentEl.innerHTML = this.parseLogs(data.logs) || '<div class="empty-state">Chưa có nhật ký hoạt động nào.</div>';
      
      // Initialize Lucide icons for new elements
      if (window.lucide) {
        window.lucide.createIcons();
      }
    } catch (err) {
      console.error(err);
      this.logsContentEl.innerHTML = '<div class="empty-state text-danger">Lỗi tải nhật ký hoạt động.</div>';
    }
  },

  parseLogs(logText) {
    if (!logText) return '<div class="empty-state">Chưa có nhật ký hoạt động nào.</div>';
    
    const lines = logText.split('\n');
    const entries = [];
    const lineRegex = /^-?\s*\[([^\]]+)\]\s*(.*)$/;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      const match = trimmed.match(lineRegex);
      if (match) {
        const timestamp = match[1];
        let message = match[2];
        
        // Convert Markdown links: [Text](url) -> HTML links
        message = message.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
          if (url.endsWith('.md')) {
            return `<a href="#" class="log-link" onclick="app.loadWikiPage('${url}'); return false;">${label}</a>`;
          }
          return `<a href="${url}" target="_blank" class="log-link">${label}</a>`;
        });
        
        entries.push({
          timestamp: new Date(timestamp),
          message: message
        });
      }
    }
    
    // Sort descending by timestamp (newest first)
    entries.sort((a, b) => b.timestamp - a.timestamp);
    
    if (entries.length === 0) {
      return '<div class="empty-state">Chưa có nhật ký hoạt động nào.</div>';
    }
    
    return `
      <div class="activity-timeline">
        ${entries.map(entry => {
          const dateStr = entry.timestamp.toLocaleString('vi-VN', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          });
          
          let icon = 'activity';
          let badgeClass = 'badge-info';
          
          if (entry.message.includes('Nạp tài liệu')) {
            icon = 'upload-cloud';
            badgeClass = 'badge-success';
          } else if (entry.message.includes('Đã xóa')) {
            icon = 'trash-2';
            badgeClass = 'badge-danger';
          } else if (entry.message.includes('Đã giải quyết mâu thuẫn')) {
            icon = 'check-circle';
            badgeClass = 'badge-warning';
          } else if (entry.message.includes('Cơ sở tri thức được tạo')) {
            icon = 'plus-circle';
            badgeClass = 'badge-primary';
          } else if (entry.message.includes('updated page') || entry.message.includes('Updated page') || entry.message.includes('Manually updated')) {
            icon = 'edit-3';
            badgeClass = 'badge-info';
          }
          
          return `
            <div class="timeline-item">
              <div class="timeline-badge ${badgeClass}">
                <i data-lucide="${icon}"></i>
              </div>
              <div class="timeline-content">
                <div class="timeline-time">${dateStr}</div>
                <div class="timeline-message">${entry.message}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  },

  showPageSelectionPrompt(show) {
    if (show) {
      this.noPageEl.classList.remove('hidden');
      this.pageViewEl.classList.add('hidden');
    } else {
      this.noPageEl.classList.add('hidden');
      this.pageViewEl.classList.remove('hidden');
    }
  },

  async loadWikiPage(filename) {
    if (!app.state.currentProjectId || !filename) return;
    
    app.state.currentWikiFilename = filename;
    
    // Highlight page list item
    const items = this.pagesListEl.querySelectorAll('.wiki-item');
    items.forEach(it => {
      it.classList.toggle('active', it.dataset.filename === filename);
    });

    try {
      const res = await fetch(`/api/projects/${app.state.currentProjectId}/wiki/${filename}`);
      if (!res.ok) throw new Error('Failed to read wiki page');
      const page = await res.json();
      
      this.showPageSelectionPrompt(false);
      this.toggleEditorMode(false);
      
      // Set text content
      this.pageTitleEl.textContent = page.title;
      this.pageFilenameEl.textContent = page.filename;

      let contradictionHtml = '';
      if (page.frontmatter && page.frontmatter.contradiction) {
        const originalContent = page.frontmatter.originalContent || '';
        contradictionHtml = `
          <div class="contradiction-resolver">
            <div class="contradiction-header">
              <i data-lucide="alert-triangle"></i>
              <div>
                <div class="contradiction-title">Phát hiện mâu thuẫn tri thức</div>
                <div class="contradiction-description">${app.escapeHtml(page.frontmatter.contradiction)}</div>
              </div>
            </div>
            <div class="contradiction-compare-grid">
              <div class="contradiction-option-card option-a">
                <div class="contradiction-option-title">Lựa chọn A: Giữ dữ liệu hiện tại</div>
                <div class="contradiction-option-body">${app.escapeHtml(originalContent || '(Trống)')}</div>
                <div class="contradiction-option-action">
                  <button class="btn btn-primary btn-sm btn-select-option-a">
                    <span>Chọn dữ liệu A</span>
                  </button>
                </div>
              </div>
              <div class="contradiction-option-card option-b">
                <div class="contradiction-option-title">Lựa chọn B: Chấp nhận dữ liệu mới</div>
                <div class="contradiction-option-body">${app.escapeHtml(page.markdown || '(Trống)')}</div>
                <div class="contradiction-option-action">
                  <button class="btn btn-success btn-sm btn-select-option-b">
                    <span>Chọn dữ liệu B</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
      }
      this.readerEl.innerHTML = contradictionHtml + page.html;
      this.updateMpeUI();
      
      // Keep markdown in text area ready for editor
      this.markdownTextarea.value = page.markdown;

      // Bind resolve handlers
      const selectOptionABtn = this.readerEl.querySelector('.btn-select-option-a');
      const selectOptionBBtn = this.readerEl.querySelector('.btn-select-option-b');

      const resolveContradiction = async (resolution) => {
        const optionName = resolution === 'keep_a' ? 'Lựa chọn A (Giữ dữ liệu cũ)' : 'Lựa chọn B (Chấp nhận dữ liệu mới)';
        if (confirm(`Bạn có chắc chắn muốn giải quyết mâu thuẫn bằng cách chọn ${optionName}?`)) {
          try {
            const res = await fetch(`/api/projects/${app.state.currentProjectId}/wiki/${page.filename}/resolve-contradiction`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ resolution })
            });
            if (!res.ok) throw new Error('Resolve failed');
            app.showToast('Đã giải quyết mâu thuẫn thành công.', 'success');
            
            // Refresh sidebar page list to clear contradiction warning style
            const projRes = await fetch(`/api/projects/${app.state.currentProjectId}`);
            if (projRes.ok) {
              const data = await projRes.json();
              this.renderPagesList(data.pages);
            }

            this.loadWikiPage(page.filename);
            this.runWikiMaintenance(true);
          } catch (err) {
            console.error(err);
            app.showToast('Giải quyết mâu thuẫn thất bại.', 'error');
          }
        }
      };

      if (selectOptionABtn) {
        selectOptionABtn.addEventListener('click', () => resolveContradiction('keep_a'));
      }
      if (selectOptionBBtn) {
        selectOptionBBtn.addEventListener('click', () => resolveContradiction('keep_b'));
      }
      
      // Re-trigger layout icons
      lucide.createIcons();
      
      // Emit event for graph and chat synchronization
      app.events.emit('wiki:page-loaded', filename);
    } catch (err) {
      console.error(err);
      app.showToast('Không thể mở trang tri thức này.', 'error');
    }
  },

  toggleEditorMode(edit) {
    if (edit) {
      this.readerEl.classList.add('hidden');
      this.editorContainer.classList.remove('hidden');
      this.markdownTextarea.focus();
    } else {
      this.readerEl.classList.remove('hidden');
      this.editorContainer.classList.add('hidden');
    }
  },

  async saveWikiPage() {
    const projId = app.state.currentProjectId;
    const filename = app.state.currentWikiFilename;
    const textContent = this.markdownTextarea.value;
    
    if (!projId || !filename) return;

    try {
      const res = await fetch(`/api/projects/${projId}/wiki/${filename}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown: textContent })
      });
      
      if (!res.ok) throw new Error('Save failed');
      
      app.showToast('Đã lưu trang tri thức thành công!', 'success');
      this.toggleEditorMode(false);
      
      // Reload current page and trigger refresh on tree
      await this.loadWikiPage(filename);
      app.events.emit('wiki:page-updated');
      
      // Update logs tab in background
      this.fetchLogs();
    } catch (err) {
      console.error(err);
      app.showToast('Lưu trang tri thức thất bại.', 'error');
    }
  },

  async deleteWikiPage() {
    const projId = app.state.currentProjectId;
    const filename = app.state.currentWikiFilename;
    
    if (!projId || !filename) return;
    
    if (filename === 'index.md' || filename === 'overview.md' || filename === 'log.md') {
      app.showToast('Không được phép xóa các trang hệ thống quan trọng này.', 'warning');
      return;
    }

    if (!confirm(`Bạn có chắc chắn muốn XÓA trang "${filename.replace('.md', '').replace(/_/g, ' ')}"?\nHệ thống sẽ tự động dọn dẹp các liên kết hỏng dẫn tới trang này.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/projects/${projId}/wiki/${filename}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      
      app.showToast(`Đã xóa trang "${filename}" và hoàn tất dọn dẹp liên kết hỏng.`, 'success');
      
      // Reset state and reload directory
      app.state.currentWikiFilename = null;
      app.events.emit('wiki:page-deleted');
      this.refreshWorkspace(projId);
    } catch (err) {
      console.error(err);
      app.showToast('Xóa trang tri thức thất bại.', 'error');
    }
  },

  // Upload Logic
  async handleFileSelection(files) {
    if (!files || files.length === 0) return;
    const projId = app.state.currentProjectId;
    if (!projId) {
      app.showToast('Vui lòng chọn hoặc tạo dự án trước khi nạp tài liệu!', 'warning');
      return;
    }

    // Switch to sources tab automatically
    this.switchSidebarTab('tab-sources');

    this.progressWrapper.classList.remove('hidden');
    this.progressBar.style.width = '10%';
    this.progressPercent.textContent = '10%';
    this.progressText.textContent = 'Đang chuẩn bị nạp tài liệu...';

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    try {
      this.progressBar.style.width = '30%';
      this.progressPercent.textContent = '30%';
      this.progressText.textContent = 'Đang tải lên server...';
      
      // We will perform the upload
      const res = await fetch(`/api/projects/${projId}/upload`, {
        method: 'POST',
        body: formData
      });

      this.progressBar.style.width = '60%';
      this.progressPercent.textContent = '60%';
      this.progressText.textContent = 'LLM đang phân tích và cấu trúc tri thức...';

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Upload failed');
      }
      
      const data = await res.json();
      
      this.progressBar.style.width = '100%';
      this.progressPercent.textContent = '100%';
      this.progressText.textContent = 'Hoàn thành nạp tri thức!';

      app.showToast('Tải lên và phân tích tri thức hoàn tất!', 'success');
      
      // Trigger a workspace reload to update tree pages & sources list
      this.refreshWorkspace(projId);
      app.events.emit('source:uploaded');
    } catch (err) {
      console.error(err);
      app.showToast(`Lỗi khi nạp tài liệu: ${err.message}`, 'error');
    } finally {
      // Hide progress bar after 3 seconds
      setTimeout(() => {
        this.progressWrapper.classList.add('hidden');
      }, 3000);
      
      // Reset file input element value
      this.fileInput.value = '';
    }
  },

  updateMpeUI() {
    if (!this.toggleMpeBtn) return;
    const textEl = document.getElementById('mpe-toggle-text');
    const icon = this.toggleMpeBtn.querySelector('[data-lucide]');
    if (this.mpeMode) {
      this.readerEl.classList.add('mpe-preview');
      if (textEl) textEl.textContent = 'Giao diện: MPE';
      this.toggleMpeBtn.classList.add('active');
      if (icon) icon.setAttribute('data-lucide', 'eye-off');
    } else {
      this.readerEl.classList.remove('mpe-preview');
      if (textEl) textEl.textContent = 'Giao diện: Mặc định';
      this.toggleMpeBtn.classList.remove('active');
      if (icon) icon.setAttribute('data-lucide', 'eye');
    }
    lucide.createIcons();
  },

  async runWikiMaintenance(silent = false) {
    const projId = app.state.currentProjectId;
    if (!projId) {
      if (!silent) app.showToast('Vui lòng chọn dự án trước.', 'warning');
      return;
    }

    const originalHtml = this.runMaintenanceBtn.innerHTML;
    this.runMaintenanceBtn.disabled = true;
    this.runMaintenanceBtn.innerHTML = '<i data-lucide="loader" class="animate-spin"></i><span>Đang phân tích Wiki...</span>';
    lucide.createIcons();

    try {
      const res = await fetch(`/api/projects/${projId}/maintenance`);
      if (!res.ok) throw new Error('Maintenance scan failed');
      const data = await res.json();

      // Render Orphans
      this.currentOrphans = data.orphans || [];
      this.orphanPagesList.innerHTML = '';
      if (this.currentOrphans.length === 0) {
        if (this.autoLinkAllBtn) this.autoLinkAllBtn.classList.add('hidden');
        this.orphanPagesList.innerHTML = `
          <li class="empty-state">
            <i data-lucide="check-circle" style="color: var(--success); width: 16px; height: 16px;"></i>
            <p>Không có trang mồ côi nào! Mọi trang đều được kết nối.</p>
          </li>
        `;
      } else {
        const hasAnySuggestions = this.currentOrphans.some(o => o.suggestions && o.suggestions.length > 0);
        if (this.autoLinkAllBtn) {
          if (hasAnySuggestions) {
            this.autoLinkAllBtn.classList.remove('hidden');
          } else {
            this.autoLinkAllBtn.classList.add('hidden');
          }
        }
        data.orphans.forEach(orph => {
          const li = document.createElement('li');
          li.className = 'maintenance-item';
          
          let suggestionsHtml = '';
          if (orph.suggestions && orph.suggestions.length > 0) {
            suggestionsHtml = `
              <div class="orphan-suggestion-box">
                <div class="orphan-suggestion-title">Đề xuất kết nối từ AI:</div>
                ${orph.suggestions.map(s => `
                  <div class="orphan-suggestion-item">
                    <div>Nên đặt liên kết tại: <a class="orphan-suggestion-link" data-filename="${s.target}">${s.target.replace('.md', '').replace(/_/g, ' ')}</a></div>
                    <div class="orphan-suggestion-reason">Lý do: ${s.reason}</div>
                  </div>
                `).join('')}
              </div>
            `;
          }

          li.innerHTML = `
            <div class="maintenance-item-header">
              <span class="maintenance-item-title" data-filename="${orph.filename}">${orph.title}</span>
              <span class="badge badge-warning" style="font-size: 10px; background: rgba(245, 158, 11, 0.1); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.2); padding: 2px 6px; border-radius: 4px;">Chưa liên kết</span>
            </div>
            <p class="maintenance-item-desc" style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 5px;">
              Trang này không có liên kết nào từ trang khác dẫn tới.
            </p>
            ${suggestionsHtml}
          `;

          // Link navigate handlers
          li.querySelectorAll('[data-filename]').forEach(el => {
            el.addEventListener('click', (e) => {
              e.preventDefault();
              const fn = el.dataset.filename;
              app.events.emit('wiki:page-selected', fn);
            });
          });

          this.orphanPagesList.appendChild(li);
        });
      }

      // Render Research Gaps
      this.gapsList.innerHTML = '';
      if (!data.gaps || data.gaps.length === 0) {
        this.gapsList.innerHTML = `
          <li class="empty-state">
            <i data-lucide="check-circle" style="color: var(--success); width: 16px; height: 16px;"></i>
            <p>Tuyệt vời! Không phát hiện lỗ hổng nghiên cứu lớn nào.</p>
          </li>
        `;
      } else {
        data.gaps.forEach(gap => {
          const li = document.createElement('li');
          li.className = 'gap-item';
          
          const tagsHtml = (gap.suggested_topics || []).map(t => `<span class="gap-tag">${t}</span>`).join('');

          li.innerHTML = `
            <div class="gap-title" style="margin-bottom: 5px;">${gap.gap}</div>
            <div class="gap-desc">${gap.description}</div>
            <div class="gap-tags">${tagsHtml}</div>
          `;
          this.gapsList.appendChild(li);
        });
      }

      // Render Contradictions
      this.contradictionsList.innerHTML = '';
      if (!data.contradictions || data.contradictions.length === 0) {
        this.contradictionsList.innerHTML = `
          <li class="empty-state">
            <i data-lucide="check-circle" style="color: var(--success); width: 16px; height: 16px;"></i>
            <p>Không phát hiện mâu thuẫn tri thức nào.</p>
          </li>
        `;
      } else {
        data.contradictions.forEach(c => {
          const li = document.createElement('li');
          li.className = 'maintenance-item';
          li.innerHTML = `
            <div class="maintenance-item-header">
              <span class="maintenance-item-title" data-filename="${c.filename}">${c.title}</span>
              <span class="badge badge-danger" style="font-size: 10px; background: rgba(239, 68, 68, 0.1); color: #EF4444; border: 1px solid rgba(239, 68, 68, 0.2); padding: 2px 6px; border-radius: 4px;">Mâu thuẫn</span>
            </div>
            <p class="maintenance-item-desc" style="font-size: 0.8rem; color: #EF4444; margin-top: 5px;">
              <strong>Chi tiết:</strong> ${c.contradiction}
            </p>
          `;
          li.querySelector('.maintenance-item-title').addEventListener('click', () => {
            app.events.emit('wiki:page-selected', c.filename);
          });
          this.contradictionsList.appendChild(li);
        });
      }

      // Automatically refresh the knowledge graph to reflect current node statuses
      if (typeof GraphManager !== 'undefined' && GraphManager.loadGraphData) {
        GraphManager.loadGraphData();
      }

      if (!silent) app.showToast('Phân tích Wiki hoàn tất!', 'success');
    } catch (err) {
      console.error(err);
      if (!silent) app.showToast('Phân tích Wiki thất bại.', 'error');
    } finally {
      this.runMaintenanceBtn.disabled = false;
      this.runMaintenanceBtn.innerHTML = originalHtml;
      lucide.createIcons();
    }
  },

  async autoLinkAllOrphans() {
    const projId = app.state.currentProjectId;
    if (!projId) {
      app.showToast('Vui lòng chọn dự án trước.', 'warning');
      return;
    }

    if (!this.currentOrphans || this.currentOrphans.length === 0) {
      app.showToast('Không có trang mồ côi nào để liên kết.', 'info');
      return;
    }

    const orphansWithSuggestions = this.currentOrphans.filter(o => o.suggestions && o.suggestions.length > 0);
    if (orphansWithSuggestions.length === 0) {
      app.showToast('Không có đề xuất kết nối AI nào cho các trang mồ côi hiện tại.', 'info');
      return;
    }

    const originalHtml = this.autoLinkAllBtn.innerHTML;
    this.autoLinkAllBtn.disabled = true;
    this.autoLinkAllBtn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 12px; height: 12px;"></i><span>Đang liên kết...</span>';
    lucide.createIcons();

    try {
      const res = await fetch(`/api/projects/${projId}/wiki/auto-link-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orphans: orphansWithSuggestions })
      });

      if (!res.ok) {
        throw new Error('Auto-link all failed');
      }

      const result = await res.json();
      app.showToast(result.message || 'Đã tự động liên kết tất cả thành công!', 'success');
      
      // Refresh sidebar list to update link statuses
      const projRes = await fetch(`/api/projects/${projId}`);
      if (projRes.ok) {
        const data = await projRes.json();
        this.renderPagesList(data.pages);
      }

      // Re-run wiki maintenance silently to update the UI list
      await this.runWikiMaintenance(true);
    } catch (err) {
      console.error(err);
      app.showToast('Có lỗi xảy ra khi tự động liên kết.', 'error');
    } finally {
      this.autoLinkAllBtn.disabled = false;
      this.autoLinkAllBtn.innerHTML = originalHtml;
      lucide.createIcons();
    }
  }
};

// ==========================================
// 3. KNOWLEDGE GRAPH MODULE (D3.JS VISUALIZER)
// ==========================================
const GraphManager = {
  init() {
    this.svg = d3.select("#knowledge-graph");
    this.g = this.svg.append("g"); // Container for zoom transforms
    this.wrapper = document.getElementById('graph-wrapper');
    this.refreshBtn = document.getElementById('btn-refresh-graph');
    
    // Zoom control buttons
    this.zoomInBtn = document.getElementById('btn-zoom-in');
    this.zoomOutBtn = document.getElementById('btn-zoom-out');
    this.zoomFitBtn = document.getElementById('btn-zoom-fit');

    // Setup zoom behaviors
    this.zoomBehavior = d3.zoom()
      .scaleExtent([0.1, 8])
      .on("zoom", (event) => {
        this.g.attr("transform", event.transform);
      });
      
    this.svg.call(this.zoomBehavior);

    // Bind UI actions
    this.refreshBtn.addEventListener('click', () => this.loadGraphData());
    this.zoomInBtn.addEventListener('click', () => this.zoom(1.3));
    this.zoomOutBtn.addEventListener('click', () => this.zoom(0.7));
    this.zoomFitBtn.addEventListener('click', () => this.zoomFit());

    // Auto resize graph container when window resizes
    window.addEventListener('resize', () => this.handleResize());

    // Subscriptions
    app.events.on('project:changed', () => this.loadGraphData());
    app.events.on('wiki:page-loaded', (filename) => this.highlightActiveNode(filename));
    app.events.on('wiki:page-updated', () => this.loadGraphData());
    app.events.on('wiki:page-deleted', () => this.loadGraphData());
    app.events.on('source:uploaded', () => this.loadGraphData());
  },

  handleResize() {
    const width = this.wrapper.clientWidth;
    const height = this.wrapper.clientHeight;
    this.svg.attr("width", width).attr("height", height);
  },

  zoom(factor) {
    this.svg.transition().duration(250).call(this.zoomBehavior.scaleBy, factor);
  },

  zoomFit() {
    const bounds = this.g.node().getBBox();
    const parent = this.svg.node();
    const fullWidth = parent.clientWidth || this.wrapper.clientWidth;
    const fullHeight = parent.clientHeight || this.wrapper.clientHeight;
    const width = bounds.width;
    const height = bounds.height;
    
    if (width === 0 || height === 0) return; // Empty graph
    
    const midX = bounds.x + width / 2;
    const midY = bounds.y + height / 2;
    const scale = 0.8 / Math.max(width / fullWidth, height / fullHeight);
    
    const transform = d3.zoomIdentity
      .translate(fullWidth / 2 - scale * midX, fullHeight / 2 - scale * midY)
      .scale(scale);
      
    this.svg.transition().duration(500).call(this.zoomBehavior.transform, transform);
  },

  async loadGraphData() {
    const projId = app.state.currentProjectId;
    if (!projId) return;

    this.handleResize();
    
    try {
      const res = await fetch(`/api/projects/${projId}/graph`);
      if (!res.ok) throw new Error('Failed to load graph data');
      const graph = await res.json();
      
      this.renderGraph(graph);
    } catch (err) {
      console.error(err);
      app.showToast('Không thể tải sơ đồ liên kết tri thức.', 'error');
    }
  },

  renderGraph(data) {
    const self = this;
    const width = this.wrapper.clientWidth || 400;
    const height = this.wrapper.clientHeight || 300;
    
    // Clear previous drawing contents
    this.g.selectAll("*").remove();

    if (!data.nodes || data.nodes.length === 0) {
      this.g.append("text")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#64748B")
        .style("font-size", "12px")
        .text("Chưa đủ dữ liệu để vẽ sơ đồ tri thức.");
      return;
    }

    // Colors mapping
    const colorScale = d3.scaleOrdinal()
      .domain(["index", "overview", "contradiction", "orphan", "gap", "other"])
      .range(["#10B981", "#0EA5E9", "#EF4444", "#F59E0B", "#A855F7", "#6366F1"]); // Green, sky blue, Red, Orange, Purple, Indigo

    const getNodeColor = (d) => {
      if (d.isContradiction) return '#EF4444'; // Red for contradiction
      if (d.isOrphan) return '#F59E0B';        // Orange/Yellow for orphans
      if (d.isGap) return '#A855F7';           // Purple for gaps
      if (d.id === 'index') return '#10B981';
      if (d.id === 'overview') return '#0EA5E9';
      return '#6366F1';
    };

    // Force Simulation Setup
    const simulation = d3.forceSimulation(data.nodes)
      .force("link", d3.forceLink(data.links).id(d => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-150))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(28));

    // Render links
    const link = this.g.append("g")
      .attr("class", "links")
      .selectAll("line")
      .data(data.links)
      .enter().append("line")
      .attr("class", "graph-link")
      .attr("stroke-dasharray", d => d.isVirtual ? "4,4" : "3,3")
      .attr("stroke", d => d.isVirtual ? "rgba(168, 85, 247, 0.4)" : "rgba(255, 255, 255, 0.12)");

    // Render node groups (wrapper to hold node and text)
    const nodeGroup = this.g.append("g")
      .attr("class", "nodes-group");

    const nodeElements = nodeGroup.selectAll("g")
      .data(data.nodes)
      .enter().append("g")
      .call(drag(simulation));

    // Circle Node elements
    const node = nodeElements.append("circle")
      .attr("class", "graph-node")
      .attr("r", d => d.id === 'index' || d.id === 'overview' ? 14 : 9)
      .attr("fill", getNodeColor)
      .style("stroke", d => d.isGap ? "#A855F7" : "none")
      .style("stroke-dasharray", d => d.isGap ? "2,2" : "none")
      .attr("id", d => `node-${d.id}`)
      .on("click", (event, d) => {
        event.stopPropagation();
        if (d.isGap) {
          app.showToast(`Lỗ hổng kiến thức: ${d.description || 'Chưa được nghiên cứu'}`, 'info');
          return;
        }
        app.events.emit('wiki:page-selected', `${d.id}.md`);
      });

    // Text Label elements
    const label = nodeElements.append("text")
      .attr("class", "graph-label")
      .attr("dy", d => d.id === 'index' || d.id === 'overview' ? 24 : 18)
      .attr("id", d => `label-${d.id}`)
      .style("fill", d => d.isGap ? "#C084FC" : "#E2E8F0")
      .text(d => d.label);

    // Apply simulation updates on tick
    simulation.on("tick", () => {
      link
        .attr("x1", d => d.source.x)
        .attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x)
        .attr("y2", d => d.target.y);

      nodeElements.attr("transform", d => `translate(${d.x}, ${d.y})`);
    });

    // Node Drag helpers
    function drag(sim) {
      function dragstarted(event, d) {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      }
      function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
      }
      function dragended(event, d) {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      }
      return d3.drag()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended);
    }

    // Keep simulation running
    simulation.alpha(1).restart();
    
    // Fit to view initially
    setTimeout(() => this.zoomFit(), 300);

    // If a node is already active, highlight it
    if (app.state.currentWikiFilename) {
      this.highlightActiveNode(app.state.currentWikiFilename);
    }
  },

  highlightActiveNode(filename) {
    if (!filename) return;
    const activeId = filename.replace('.md', '');
    
    // Remove active styles from all nodes
    this.g.selectAll(".graph-node").classed("active", false);
    this.g.selectAll(".graph-label").classed("active", false);
    this.g.selectAll(".graph-link").classed("highlighted", false);

    // Add active styles
    this.g.select(`#node-${activeId}`).classed("active", true);
    this.g.select(`#label-${activeId}`).classed("active", true);

    // Highlight links connected to this active node
    this.g.selectAll(".graph-link").each(function(l) {
      if (l.source.id === activeId || l.target.id === activeId) {
        d3.select(this).classed("highlighted", true);
      }
    });
  }
};

// ==========================================
// 4. CHAT DRAWER & INTERACTIVE Q&A MODULE
// ==========================================
const ChatManager = {
  init() {
    this.chatForm = document.getElementById('chat-form');
    this.chatInput = document.getElementById('chat-input');
    this.chatThread = document.getElementById('chat-thread');
    this.suggestionsContainer = document.getElementById('chat-suggestions');
    this.chatTabBtn = document.getElementById('tab-btn-chat');
    this.chatInputWrapper = document.getElementById('chat-input-wrapper');
    this.contextTagsContainer = document.getElementById('chat-context-tags');
    this.selectedContextFiles = [];
    
    // Form trigger
    this.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.chatInput.value.trim();
      if (q) this.submitUserQuery(q);
    });

    // suggestions click handlers
    this.suggestionsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.suggestion-item');
      if (btn) {
        const text = btn.textContent.trim();
        this.submitUserQuery(text);
      }
    });

    // Drag & Drop event handling for chat input container
    if (this.chatInputWrapper) {
      this.chatInputWrapper.addEventListener('dragover', (e) => {
        e.preventDefault();
        this.chatInputWrapper.classList.add('drag-over');
      });

      this.chatInputWrapper.addEventListener('dragleave', () => {
        this.chatInputWrapper.classList.remove('drag-over');
      });

      this.chatInputWrapper.addEventListener('drop', (e) => {
        e.preventDefault();
        this.chatInputWrapper.classList.remove('drag-over');
        
        try {
          const jsonStr = e.dataTransfer.getData('application/json');
          if (jsonStr) {
            const data = JSON.parse(jsonStr);
            if (data && data.filename) {
              this.addContextFile(data);
            }
          } else {
            const filename = e.dataTransfer.getData('text/plain');
            if (filename && filename.endsWith('.md')) {
              const title = filename.replace('.md', '').replace(/_/g, ' ');
              this.addContextFile({ filename, title });
            }
          }
        } catch (err) {
          console.error('Error handling wiki-item drop:', err);
        }
      });
    }

    // Subscriptions
    app.events.on('project:changed', () => this.clearChatHistory());
  },

  addContextFile(fileObj) {
    const exists = this.selectedContextFiles.some(f => f.filename === fileObj.filename);
    if (!exists) {
      this.selectedContextFiles.push(fileObj);
      this.renderContextTags();
    }
  },

  removeContextFile(filename) {
    this.selectedContextFiles = this.selectedContextFiles.filter(f => f.filename !== filename);
    this.renderContextTags();
  },

  renderContextTags() {
    if (!this.contextTagsContainer) return;
    this.contextTagsContainer.innerHTML = '';
    
    if (this.selectedContextFiles.length === 0) {
      this.contextTagsContainer.style.display = 'none';
      return;
    }
    
    this.contextTagsContainer.style.display = 'flex';
    this.selectedContextFiles.forEach(file => {
      const tag = document.createElement('div');
      tag.className = 'chat-context-tag';
      tag.innerHTML = `
        <i data-lucide="file-text" style="width: 12px; height: 12px;"></i>
        <span>${file.title}</span>
        <button type="button" class="btn-remove-tag" title="Xóa ngữ cảnh">
          <i data-lucide="x" style="width: 10px; height: 10px;"></i>
        </button>
      `;
      
      tag.querySelector('.btn-remove-tag').addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeContextFile(file.filename);
      });
      
      this.contextTagsContainer.appendChild(tag);
    });
    
    lucide.createIcons();
  },

  clearChatHistory() {
    this.selectedContextFiles = [];
    this.renderContextTags();
    this.chatThread.innerHTML = `
      <div class="chat-message assistant">
        <div class="message-avatar">
          <i data-lucide="bot"></i>
        </div>
        <div class="message-bubble">
          <p>Xin chào! Tôi là trợ lý tri thức MinusWiki. Tôi có thể giải đáp các câu hỏi dựa trên tài liệu nguồn bạn đã tải lên dự án này.</p>
        </div>
      </div>
    `;
    lucide.createIcons();
    this.renderSuggestions([
      "Cơ sở tri thức này chứa thông tin gì?",
      "Trang chủ (Overview) nói về điều gì?",
      "Đọc lịch sử cập nhật (Log) gần đây"
    ]);
  },

  renderSuggestions(suggestions) {
    this.suggestionsContainer.innerHTML = '';
    if (!suggestions || suggestions.length === 0) {
      this.suggestionsContainer.innerHTML = '<span class="text-muted">Không có câu hỏi gợi ý.</span>';
      return;
    }
    
    suggestions.forEach(s => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-secondary btn-sm suggestion-item';
      btn.textContent = s;
      this.suggestionsContainer.appendChild(btn);
    });
  },

  appendMessage(text, isUser = false, sources = [], suggestions = []) {
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isUser ? 'user' : 'assistant'}`;
    msgDiv.id = msgId;
    
    const iconName = isUser ? 'user' : 'bot';
    
    // Render answer as HTML
    let messageContentHtml = '';
    if (isUser) {
      messageContentHtml = `<p>${text || ''}</p>`;
    } else {
      // Use Marked for assistant answers
      messageContentHtml = marked.parse(text || 'Không có phản hồi từ hệ thống.');
    }

    // Build citations block
    let citationsHtml = '';
    if (!isUser && sources && sources.length > 0) {
      citationsHtml = `
        <div class="citation-badges-wrapper">
          <span class="citation-label">Tham chiếu:</span>
          ${sources.map(src => `<span class="citation-badge" data-filename="${src}.md"><i data-lucide="link-2"></i>${src.replace(/_/g, ' ')}</span>`).join('')}
        </div>
      `;
    }

    const hasContradiction = !isUser && text && ["Mâu thuẫn tiềm ẩn", "Xung đột dữ liệu", "Thông tin bất nhất", "Đá nhau"].some(kw => text.includes(kw));
    const hasSolution = !isUser && text && ["Khuyến nghị", "Đề xuất", "Giải pháp", "Gợi ý"].some(kw => text.includes(kw));

    let mergeBtnHtml = '';
    if (hasContradiction && hasSolution) {
      mergeBtnHtml = `
        <div class="merge-wiki-btn-wrapper" style="margin-top: 6px; display: flex; align-items: center;">
          <button id="btn-merge-wiki" class="btn-primary" style="padding: 6px 12px; font-size: 0.85rem; border-radius: var(--radius-sm); display: flex; align-items: center; gap: 6px;">Cập nhật Wiki</button>
        </div>
      `;
    }

    msgDiv.innerHTML = `
      <div class="message-avatar">
        <i data-lucide="${iconName}"></i>
      </div>
      <div class="message-content-wrapper" style="display: flex; flex-direction: column; gap: 4px; flex-grow: 1;">
        <div class="message-bubble">
          ${messageContentHtml}
          ${citationsHtml}
        </div>
        ${mergeBtnHtml}
      </div>
    `;

    this.chatThread.appendChild(msgDiv);
    lucide.createIcons();

    // Auto-scroll chat thread to bottom
    this.chatThread.scrollTop = this.chatThread.scrollHeight;

    // Attach click events to citations
    if (!isUser && sources && sources.length > 0) {
      msgDiv.querySelectorAll('.citation-badge').forEach(badge => {
        badge.addEventListener('click', () => {
          const fn = badge.dataset.filename;
          app.events.emit('wiki:page-selected', fn);
        });
      });
    }

    // Attach click event to btn-merge-wiki
    if (hasContradiction && hasSolution) {
      const btn = msgDiv.querySelector('#btn-merge-wiki');
      if (btn) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const originalHtml = btn.innerHTML;
          btn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 14px; height: 14px;"></i> <span>Đang cập nhật...</span>';
          if (window.lucide) window.lucide.createIcons();

          try {
            const res = await fetch('/api/maintenance/merge-wiki', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messageId: msgId,
                projectId: app.state.currentProjectId
              })
            });

            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || 'Cập nhật thất bại');
            }

            btn.innerHTML = 'Cập nhật thành công!';
            btn.style.backgroundColor = 'var(--success)';
            btn.style.borderColor = 'var(--success)';
            setTimeout(() => {
              btn.style.display = 'none';
            }, 2000);
          } catch (err) {
            console.error(err);
            app.showToast(`Lỗi: ${err.message}`, 'error');
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) window.lucide.createIcons();
          }
        });
      }
    }
    
    // Update suggestions if provided
    if (!isUser && suggestions && suggestions.length > 0) {
      this.renderSuggestions(suggestions);
    }
  },

  showTypingIndicator(show) {
    const existing = document.getElementById('typing-indicator-wrapper');
    if (existing) existing.remove();

    if (show) {
      const indicator = document.createElement('div');
      indicator.className = 'chat-message assistant';
      indicator.id = 'typing-indicator-wrapper';
      indicator.innerHTML = `
        <div class="message-avatar">
          <i data-lucide="bot"></i>
        </div>
        <div class="message-bubble">
          <div class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
          </div>
        </div>
      `;
      this.chatThread.appendChild(indicator);
      lucide.createIcons();
      this.chatThread.scrollTop = this.chatThread.scrollHeight;
    }
  },

  async submitUserQuery(queryText) {
    const projId = app.state.currentProjectId;
    if (!projId) {
      app.showToast('Vui lòng chọn hoặc tạo dự án trước!', 'warning');
      return;
    }

    // Append user message
    this.appendMessage(queryText, true);
    this.chatInput.value = '';
    
    // Switch right panel to chat tab automatically
    document.getElementById('tab-btn-chat').click();

    // Show typing loader
    this.showTypingIndicator(true);

    try {
      const res = await fetch(`/api/projects/${projId}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: queryText,
          contextFiles: this.selectedContextFiles.map(f => f.filename)
        })
      });

      this.showTypingIndicator(false);

      if (!res.ok) throw new Error('Query pipeline failed');
      const data = await res.json();
      
      // Append assistant answer
      this.appendMessage(data.answer, false, data.sources, data.suggestions);
    } catch (err) {
      console.error(err);
      this.showTypingIndicator(false);
      this.appendMessage('Đã xảy ra lỗi kết nối với mô hình ngôn ngữ hỗ trợ. Vui lòng thử lại sau.', false);
    }
  }
};

// ==========================================
// 4.5. RIGHT PANEL RESIZER MODULE
// ==========================================
const RightPanelResizer = {
  init() {
    this.resizer = document.getElementById('right-panel-resizer');
    this.panel = document.getElementById('right-panel');
    
    if (!this.resizer || !this.panel) return;
    
    this.isDragging = false;
    
    this.resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.isDragging = true;
      this.resizer.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none'; // prevent text selection during drag
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      
      // Calculate new width: viewport width - mouse X position - page padding (16px)
      const containerPadding = 16; 
      let newWidth = window.innerWidth - e.clientX - containerPadding;
      
      // Enforce min and max width constraints
      if (newWidth < 280) newWidth = 280;
      if (newWidth > window.innerWidth * 0.7) newWidth = window.innerWidth * 0.7; // max 70% of screen width
      
      this.panel.style.width = `${newWidth}px`;
    });
    
    document.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.resizer.classList.remove('is-dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Save the preferred width in localStorage
        localStorage.setItem('minuswiki_right_panel_width', this.panel.style.width);
        
        // If graph tab is active, trigger resize to update D3
        if (typeof GraphManager !== 'undefined' && GraphManager.loadGraphData) {
          GraphManager.loadGraphData();
        }
      }
    });
    
    // Load saved width on init
    const savedWidth = localStorage.getItem('minuswiki_right_panel_width');
    if (savedWidth) {
      this.panel.style.width = savedWidth;
    }
  }
};

// ==========================================
// 5. BOOTSTRAP INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // Initialize Modules
  ProjectManager.init();
  SettingsManager.init();
  GoogleDriveManager.init();
  WikiTreeManager.init();
  GraphManager.init();
  ChatManager.init();
  RightPanelResizer.init();
  
  // Right Drawer Tab switcher bind
  const panelTabButtons = document.querySelectorAll('.panel-tab-btn');
  const panelPanes = document.querySelectorAll('.right-panel-content .panel-pane');
  
  panelTabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      panelTabButtons.forEach(b => b.classList.toggle('active', b === btn));
      panelPanes.forEach(pane => pane.classList.toggle('active', pane.id === target));
      
      // If graph tab is focused, resize and redraw to prevent SVG clipping
      if (target === 'panel-graph') {
        GraphManager.loadGraphData();
      }
    });
  });

  // Global Interceptor: catch any markdown internal link clicks
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (link) {
      const href = link.getAttribute('href');
      // Look for relative Markdown file links, like concept.md or ./concept.md
      if (href && href.endsWith('.md') && !href.startsWith('http') && !href.startsWith('//')) {
        e.preventDefault();
        
        // Clean filename (strip leading ./ if present)
        const filename = href.replace(/^\.\//, '');
        app.events.emit('wiki:page-selected', filename);
      }
    }
  });
});
