#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define BUF 32768

static int exists_file(const wchar_t *path) {
  DWORD attrs = GetFileAttributesW(path);
  return attrs != INVALID_FILE_ATTRIBUTES && !(attrs & FILE_ATTRIBUTE_DIRECTORY);
}

static void dirname_inplace(wchar_t *path) {
  wchar_t *slash = wcsrchr(path, L'\\');
  wchar_t *slash2 = wcsrchr(path, L'/');
  if (!slash || (slash2 && slash2 > slash)) slash = slash2;
  if (slash) *slash = L'\0';
}

static int join_path(wchar_t *out, size_t cap, const wchar_t *root, const wchar_t *relative) {
  int written = _snwprintf(out, cap, L"%ls\\%ls", root, relative);
  return written > 0 && (size_t)written < cap;
}

static void show_error(const wchar_t *message) {
  MessageBoxW(NULL, message, L"RPGmap Launcher", MB_OK | MB_ICONERROR | MB_SETFOREGROUND);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE prev, PWSTR cmdLine, int show) {
  (void)instance; (void)prev; (void)cmdLine; (void)show;

  wchar_t exePath[BUF] = {0};
  wchar_t root[BUF] = {0};
  wchar_t script[BUF] = {0};
  wchar_t nodePath[BUF] = {0};
  wchar_t command[BUF] = {0};

  DWORD length = GetModuleFileNameW(NULL, exePath, BUF);
  if (!length || length >= BUF) {
    show_error(L"无法确定 RPGmap Launcher 所在目录。");
    return 1;
  }
  wcscpy(root, exePath);
  dirname_inplace(root);

  if (!join_path(script, BUF, root, L"launcher\\launcher.mjs") || !exists_file(script)) {
    show_error(L"未找到 launcher\\launcher.mjs。请确认 RPGmap 发布包完整解压后再运行。");
    return 2;
  }

  wchar_t candidate[BUF] = {0};
  if (join_path(candidate, BUF, root, L"tools\\node\\node.exe") && exists_file(candidate)) {
    wcscpy(nodePath, candidate);
  } else if (join_path(candidate, BUF, root, L"node.exe") && exists_file(candidate)) {
    wcscpy(nodePath, candidate);
  } else {
    DWORD found = SearchPathW(NULL, L"node.exe", NULL, BUF, nodePath, NULL);
    if (!found || found >= BUF) {
      int answer = MessageBoxW(
        NULL,
        L"未检测到 Node.js。\n\nRPGmap 当前需要 Node.js 20.19+ 或 22.12+。\n是否打开 Node.js 官网？",
        L"RPGmap Launcher",
        MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND
      );
      if (answer == IDYES) ShellExecuteW(NULL, L"open", L"https://nodejs.org/", NULL, NULL, SW_SHOWNORMAL);
      return 3;
    }
  }

  int written = _snwprintf(command, BUF, L"\"%ls\" \"%ls\"", nodePath, script);
  if (written <= 0 || written >= BUF) {
    show_error(L"Launcher 启动命令过长。");
    return 4;
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);

  BOOL ok = CreateProcessW(
    nodePath,
    command,
    NULL,
    NULL,
    FALSE,
    CREATE_NO_WINDOW,
    NULL,
    root,
    &startup,
    &process
  );

  if (!ok) {
    wchar_t errorText[512];
    _snwprintf(errorText, 512, L"无法启动 RPGmap Launcher。\nWindows 错误代码：%lu", GetLastError());
    show_error(errorText);
    return 5;
  }

  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return 0;
}
