# Script to start both backend and frontend in development mode

Write-Host "Starting BTS Development Environment..." -ForegroundColor Green

# Start backend in background
Write-Host "Starting Backend Server..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$(Get-Location)\backend'; npm run dev"

# Wait a moment for backend to start
Start-Sleep -Seconds 3

# Start frontend
Write-Host "Starting Frontend..." -ForegroundColor Yellow
Set-Location frontend
npx expo start --web

Write-Host "Development environment started!" -ForegroundColor Green