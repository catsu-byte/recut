@echo off
chcp 65001 >nul
echo ReCut - Lyrics-Setup
echo ====================
where python >nul 2>nul
if errorlevel 1 (
  echo Python wurde nicht gefunden.
  echo Bitte Python 3.12 installieren und "Add python.exe to PATH" anhaken.
  echo https://www.python.org/downloads/release/python-3128/
  pause
  exit /b 1
)
python --version
python -m pip install --upgrade pip
python -m pip install faster-whisper numpy scipy
if errorlevel 1 (
  echo.
  echo Installation fehlgeschlagen. Ist es Python 3.10 bis 3.12?
  pause
  exit /b 1
)
echo.
set /p DEMUCS="Demucs fuer bessere Lyrics installieren? (ca. 2 GB) [j/n]: "
if /i "%DEMUCS%"=="j" python -m pip install demucs
set /p YTDLP="yt-dlp als Medal-Ersatz installieren? [j/n]: "
if /i "%YTDLP%"=="j" python -m pip install yt-dlp
echo.
python -c "import faster_whisper; print('faster-whisper OK')"
echo.
echo Fertig. ReCut jetzt neu starten.
pause
