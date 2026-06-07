// extension/popup.js

let backendUrl = 'http://localhost:3000';

document.addEventListener('DOMContentLoaded', async () => {
  const serverSelect = document.getElementById('server-select');
  const projectSelect = document.getElementById('project-select');
  const titleInput = document.getElementById('clip-title');
  const textInput = document.getElementById('clip-text');
  const submitBtn = document.getElementById('btn-submit');
  const statusDiv = document.getElementById('status');

  let activeTab = null;

  // 1. Fetch current tab info & selected text
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs[0];
    if (!activeTab) return;

    // Set initial title suggestion
    titleInput.value = `Trích dẫn: ${activeTab.title || 'Trang web'}`;

    // Query active page for selection text
    chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => window.getSelection().toString()
    }, (results) => {
      if (results && results[0] && results[0].result) {
        textInput.value = results[0].result;
      } else {
        textInput.placeholder = "Hãy bôi đen văn bản trên trang để tự động trích xuất, hoặc nhập nội dung tại đây...";
      }
    });
  });

  // Function to load projects for the current backendUrl
  async function loadProjects() {
    projectSelect.innerHTML = '<option value="" disabled selected>Đang tải dự án...</option>';
    submitBtn.disabled = true;
    statusDiv.style.display = 'none';

    try {
      const res = await fetch(`${backendUrl}/api/projects`);
      if (!res.ok) throw new Error('Cannot load projects');
      const projects = await res.json();

      if (projects.length === 0) {
        projectSelect.innerHTML = '<option value="" disabled selected>Chưa có dự án nào. Hãy tạo trên Web UI.</option>';
        showStatus('Vui lòng mở trang Web MinusWiki và tạo ít nhất 1 dự án!', 'warning');
        return;
      }

      // Populate dropdown
      projectSelect.innerHTML = '';
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.title;
        projectSelect.appendChild(opt);
      });

      // Check storage for last selected project
      chrome.storage.local.get(['currentProjectId'], (result) => {
        if (result.currentProjectId && projects.some(p => p.id === result.currentProjectId)) {
          projectSelect.value = result.currentProjectId;
        } else {
          // Default to first project
          projectSelect.value = projects[0].id;
          saveActiveProjectToStorage(projects[0].id, projects[0].title);
        }
        submitBtn.disabled = false;
      });

    } catch (err) {
      console.error(err);
      projectSelect.innerHTML = '<option value="" disabled selected>Lỗi kết nối với server.</option>';
      showStatus(`Không thể kết nối với server ${backendUrl}. Hãy kiểm tra cấu hình hoặc khởi động server!`, 'error');
    }
  }

  // Load configured backend URL from storage
  chrome.storage.local.get(['backendUrl'], async (result) => {
    if (result.backendUrl) {
      backendUrl = result.backendUrl;
      if (serverSelect) {
        serverSelect.value = backendUrl;
      }
    } else {
      // Default to Localhost in dropdown and save it
      backendUrl = 'http://localhost:3000';
      chrome.storage.local.set({ backendUrl: backendUrl });
    }
    
    // Load projects initially
    await loadProjects();
  });

  // Handle server select changes
  if (serverSelect) {
    serverSelect.addEventListener('change', async () => {
      backendUrl = serverSelect.value;
      chrome.storage.local.set({ backendUrl: backendUrl });
      await loadProjects();
    });
  }

  // Handle project select changes
  projectSelect.addEventListener('change', () => {
    const selectedOpt = projectSelect.options[projectSelect.selectedIndex];
    saveActiveProjectToStorage(selectedOpt.value, selectedOpt.textContent);
  });

  // 3. Handle submit button click
  submitBtn.addEventListener('click', async () => {
    const projectId = projectSelect.value;
    const clipTitle = titleInput.value.trim();
    const clipText = textInput.value.trim();

    if (!projectId) {
      showStatus('Vui lòng chọn một dự án.', 'error');
      return;
    }
    if (!clipText) {
      showStatus('Nội dung trích dẫn không được để trống.', 'error');
      return;
    }

    submitBtn.disabled = true;
    showStatus('Đang gửi và biên soạn tri thức...', 'info');

    try {
      const res = await fetch(`${backendUrl}/api/projects/${projectId}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: clipTitle || 'Đoạn trích web',
          url: activeTab ? activeTab.url : 'http://unknown',
          text: clipText,
          html: `<p>Đoạn trích dẫn từ nguồn: <a href="${activeTab ? activeTab.url : '#'}">${activeTab ? activeTab.url : 'Web'}</a></p><blockquote>${clipText}</blockquote>`
        })
      });

      if (!res.ok) {
        throw new Error('Gửi yêu cầu thất bại');
      }

      showStatus('Đã nạp tri thức thành công!', 'success');
      
      // Auto-close popup after 2 seconds
      setTimeout(() => {
        window.close();
      }, 2000);

    } catch (err) {
      console.error(err);
      showStatus('Lỗi khi lưu tri thức vào server.', 'error');
      submitBtn.disabled = false;
    }
  });

  // Helper to store active project
  function saveActiveProjectToStorage(id, title) {
    chrome.storage.local.set({
      currentProjectId: id,
      currentProjectTitle: title
    }, () => {
      console.log(`Active project configured in storage: ${title}`);
    });
  }

  // Helper to display status message
  function showStatus(text, type) {
    statusDiv.textContent = text;
    statusDiv.style.display = 'block';
    statusDiv.className = `status-message status-${type}`;
  }
});
