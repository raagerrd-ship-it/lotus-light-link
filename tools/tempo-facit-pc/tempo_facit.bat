@echo off
cd /d %~dp0
.venv\Scripts\python.exe tempo_facit.py http://192.168.1.174:3051 >> tempo_facit.log 2>&1
