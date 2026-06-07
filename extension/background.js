// background.js - MinusWiki Extension Service Worker

// Register context menus upon installation
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "clip-to-minuswiki",
    title: "Lưu vùng chọn vào MinusWiki",
    contexts: ["selection"]
  });
  console.log("MinusWiki context menu registered.");
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "clip-to-minuswiki") {
    const selectedText = info.selectionText;
    const url = tab.url;
    const title = tab.title || "Trang web";

    // Retrieve the active project ID and backendUrl from storage
    chrome.storage.local.get(["currentProjectId", "currentProjectTitle", "backendUrl"], async (result) => {
      const projectId = result.currentProjectId;
      if (!projectId) {
        console.warn("No active project configured in extension storage.");
        return;
      }

      const serverUrl = result.backendUrl || "http://localhost:3000";
      console.log(`Clipping text to project "${result.currentProjectTitle || projectId}" via server ${serverUrl}`);
      
      try {
        const res = await fetch(`${serverUrl}/api/projects/${projectId}/clip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Đoạn trích từ: ${title}`,
            url: url,
            text: selectedText,
            html: `<p>Vùng chọn văn bản trích từ nguồn: <a href="${url}">${url}</a></p><blockquote>${selectedText}</blockquote>`
          })
        });

        if (!res.ok) {
          throw new Error(`Server returned code ${res.status}`);
        }

        const data = await res.json();
        console.log("Clipped data successfully processed:", data);
      } catch (err) {
        console.error(`Failed to send clip to MinusWiki server at ${serverUrl}:`, err);
      }
    });
  }
});
