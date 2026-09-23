@echo off
setlocal enabledelayedexpansion
title 本地语音工作台 · 一键启动

rem ============================================================================
rem  本地语音工作台 —— Windows 一键启动
rem
rem  双击本文件即可：
rem    1. 检查 Node.js 环境（要求 18 以上）
rem    2. 首次运行时自动安装依赖，并做一次本地模型服务体检
rem    3. 并行启动本地模型服务、网关与前端（三个独立进程）
rem    4. 等服务起来后自动打开浏览器
rem
rem  停止：在本窗口按 Ctrl+C，或直接关闭窗口。
rem
rem  【编码，很重要】本文件保存为 ANSI / GBK（简体中文 Windows 的默认代码页 936），
rem  并且刻意不写 chcp 65001。原因是：
rem  cmd 解析批处理时会按字节来回定位文件位置（goto / call 都会触发 seek），
rem  UTF-8 的多字节中文会让这个偏移算错，表现为某些行被从中间截断后当成命令执行
rem  —— 实测会出现「echo 前缀被吃掉」「call :check_port 变成 eck_port」这类
rem  完全看不出道理的报错。所以用记事本编辑后，请存为「ANSI」而不是 UTF-8。
rem ============================================================================

rem 双击时的工作目录未必是脚本所在目录（例如从任务栏固定项启动），显式切过去
cd /d "%~dp0"

rem ---------------------------------------------------------------- 1. Node 环境
where node >nul 2>nul
if errorlevel 1 goto :no_node

rem node -v 输出形如 v24.16.0，按 'v' 与 '.' 切分后第一段就是主版本号
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto :no_node
if !NODE_MAJOR! LSS 18 goto :old_node

echo.
echo   本地语音工作台 · 启动中
echo   Node.js v!NODE_MAJOR!  已就绪
echo.

rem ---------------------------------------------------------------- 2. 依赖
rem 用具体包路径判断而不是判断 node_modules 是否存在 ——
rem 中断过的安装会留下一个空目录，只看目录存在会误判成「已装好」。
set "NEED_INSTALL=0"
if not exist "node_modules\concurrently\package.json" set "NEED_INSTALL=1"
if not exist "app\node_modules\vite\package.json" set "NEED_INSTALL=1"
if not exist "server\node_modules\express\package.json" set "NEED_INSTALL=1"

if "!NEED_INSTALL!"=="1" (
    echo   首次运行，正在安装依赖（前端 + 网关，通常 1~3 分钟）...
    echo.
    call npm run install:all
    if errorlevel 1 goto :install_failed

    echo.
    echo   依赖安装完成。接着做一次本地模型服务体检
    echo   （探测 GPT-SoVITS 整合包、解释器与显卡，约 30 秒）
    echo.
    call npm run sovits:check
    if errorlevel 1 (
        echo.
        echo   [提示] 本地 GPT-SoVITS 服务未就绪，这不影响 MiMo 云端功能。
        echo          排查方式见 README 的「验证安装」一节。
        echo.
        pause
    )
)

rem ---------------------------------------------------------------- 3. 端口占用
rem 上一轮没关干净的服务会占住端口，导致启动失败得莫名其妙，这里提前说清楚。
call :check_port 8787 "本地网关"
call :check_port 5173 "前端开发服务器"

rem ---------------------------------------------------------------- 4. 自动开浏览器
rem 前端此刻还没起来，所以开一个最小化的后台窗口等 15 秒再打开。
rem 不想要这个行为就删掉下面这三行。
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if errorlevel 1 (
    start "" /min cmd /c "ping -n 16 127.0.0.1 >nul & start http://localhost:5173"
) else (
    echo   [提示] 5173 已被占用，Vite 会自动改用其它端口，请以终端输出为准。
)

rem ---------------------------------------------------------------- 5. 启动
echo.
echo   正在启动：
echo     · 前端页面      http://localhost:5173
echo     · 本地网关      http://127.0.0.1:8787
echo     · 本地模型服务  随启动器一同拉起（首次加载模型约 30~90 秒）
echo.
echo   停止服务：按 Ctrl+C，或直接关闭本窗口。
echo.
call npm run dev

echo.
echo   服务已退出。
pause
exit /b 0

rem ============================================================================
rem  子过程
rem ============================================================================

:check_port
netstat -ano | findstr /r /c:":%~1 .*LISTENING" >nul
if errorlevel 1 exit /b 0
echo   [警告] 端口 %~1（%~2）已被占用：
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1 .*LISTENING"') do (
    echo           占用进程 PID %%p
)
echo           可能是上次没关干净的服务。继续启动可能失败，
echo           可先执行：taskkill /F /PID ^<上面的 PID^>
echo.
exit /b 0

:no_node
echo.
echo   [错误] 没有找到 Node.js。
echo         本项目需要 Node.js 18 或更高版本，下载：https://nodejs.org/
echo         安装完成后重新双击本文件即可。
echo.
pause
exit /b 1

:old_node
echo.
echo   [错误] Node.js 版本过低（当前主版本 !NODE_MAJOR!，需要 18 以上）。
echo         请升级后重试：https://nodejs.org/
echo.
pause
exit /b 1

:install_failed
echo.
echo   [错误] 依赖安装失败。常见原因与处理：
echo          · 网络不通 —— 可换国内镜像后重试：
echo              npm config set registry https://registry.npmmirror.com
echo          · 没有写入权限 —— 不要把项目放在 C:\Program Files 下
echo          · 也可以手动在项目目录执行：npm run install:all
echo.
pause
exit /b 1
