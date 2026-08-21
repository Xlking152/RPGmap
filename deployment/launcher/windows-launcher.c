#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define BUF 32768
#define STARTUP_GRACE_MS 2200

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

static UINT dialog_flags(UINT icon) {
  return MB_SETFOREGROUND | MB_TOPMOST | MB_TASKMODAL | icon;
}

static void show_error(const wchar_t *message) {
  MessageBoxW(NULL, message, L"RPGmap Launcher", MB_OK | dialog_flags(MB_ICONERROR));
}

static void open_log(const wchar_t *logPath) {
  if (exists_file(logPath)) ShellExecuteW(NULL, L"open", logPath, NULL, NULL, SW_SHOWNORMAL);
}

static void show_startup_failure(const wchar_t *detail, const wchar_t *logPath) {
  wchar_t message[2048] = {0};
  _snwprintf(
    message,
    2048,
    L"RPGmap Launcher 后台未能正常启动。\n\n%ls\n\n启动日志：\n%ls\n\n是否现在打开启动日志？",
    detail,
    logPath
  );
  int answer = MessageBoxW(NULL, message, L"RPGmap Launcher", MB_YESNO | dialog_flags(MB_ICONERROR));
  if (answer == IDYES) open_log(logPath);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE prev, PWSTR cmdLine, int show) {
  (void)instance; (void)prev; (void)cmdLine; (void)show;

  wchar_t exePath[BUF] = {0};
  wchar_t root[BUF] = {0};
  wchar_t script[BUF] = {0};
  wchar_t nodePath[BUF] = {0};
  wchar_t command[BUF] = {0};
  wchar_t logPath[BUF] = {0};

  DWORD length = GetModuleFileNameW(NULL, exePath, BUF);
  if (!length || length >= BUF) {
    show_error(L"无法确定 RPGmap Launcher 所在目录。");
    return 1;
  }
  wcscpy(root, exePath);
  dirname_inplace(root);

  if (!join_path(script, BUF, root, L"launcher\\launcher.mjs") || !exists_file(script)) {
    show_error(L"未找到 launcher\\launcher.mjs。\n\n请不要单独移动 RPGmap Launcher.exe；请将整个 RPGmap 发布包完整解压后再运行。");
    return 2;
  }

  if (!join_path(logPath, BUF, root, L"launcher-startup.log")) {
    show_error(L"无法建立 Launcher 启动日志路径。");
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
        L"未检测到 Node.js。\n\nRPGmap 当前需要 Node.js 20.19+ 或 22.12+。\n\n如果你已经安装 Node.js，但仍看到此提示，请重新登录 Windows 或把 node.exe 放到 RPGmap 根目录。\n\n是否打开 Node.js 官网？",
        L"RPGmap Launcher",
        MB_YESNO | dialog_flags(MB_ICONWARNING)
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

  HANDLE logHandle = CreateFileW(
    logPath,
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL,
    CREATE_ALWAYS,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (logHandle == INVALID_HANDLE_VALUE) {
    show_error(L"无法创建 launcher-startup.log。\n\n请确认 RPGmap 所在目录具有写入权限。建议不要直接在压缩包内运行，也不要放在受保护的 Program Files 目录中。");
    return 4;
  }

  const char bom[] = "RPGmap Native Launcher startup log\r\n";
  DWORD ignored = 0;
  WriteFile(logHandle, bom, (DWORD)(sizeof(bom) - 1), &ignored, NULL);

  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  ZeroMemory(&startup, sizeof(startup));
  ZeroMemory(&process, sizeof(process));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = logHandle;
  startup.hStdError = logHandle;

  BOOL ok = CreateProcessW(
    nodePath,
    command,
    NULL,
    NULL,
    TRUE,
    CREATE_NO_WINDOW,
    NULL,
    root,
    &startup,
    &process
  );

  if (!ok) {
    DWORD errorCode = GetLastError();
    CloseHandle(logHandle);
    wchar_t errorText[512] = {0};
    _snwprintf(errorText, 512, L"无法创建 Node.js 进程。Windows 错误代码：%lu", errorCode);
    show_startup_failure(errorText, logPath);
    return 5;
  }

  CloseHandle(process.hThread);

  /*
   * The old native shell returned immediately here. Because Node runs with
   * CREATE_NO_WINDOW, an early launcher.mjs exception then became completely
   * invisible to the user. Give the backend a short grace period: if it exits
   * immediately, surface the real log instead of silently disappearing.
   */
  DWORD wait = WaitForSingleObject(process.hProcess, STARTUP_GRACE_MS);
  if (wait == WAIT_OBJECT_0) {
    DWORD exitCode = 0;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hProcess);
    CloseHandle(logHandle);
    wchar_t detail[512] = {0};
    _snwprintf(detail, 512, L"Node.js 进程在启动后立即退出（exit code %lu）。", exitCode);
    show_startup_failure(detail, logPath);
    return 6;
  }
  if (wait == WAIT_FAILED) {
    DWORD errorCode = GetLastError();
    CloseHandle(process.hProcess);
    CloseHandle(logHandle);
    wchar_t detail[512] = {0};
    _snwprintf(detail, 512, L"等待 Launcher 后台启动时发生 Windows 错误：%lu。", errorCode);
    show_startup_failure(detail, logPath);
    return 7;
  }

  CloseHandle(process.hProcess);
  CloseHandle(logHandle);
  return 0;
}
