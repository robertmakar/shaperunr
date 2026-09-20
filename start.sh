#!/bin/bash

echo "🚀 Starting ShapeRunr..."

# Start Docker / Valhalla
echo "🗺️ Starting Valhalla..."
cd ~/runshape/backend
docker compose up -d

# Wait for Valhalla
echo "⏳ Waiting for Valhalla..."
until curl -sf http://127.0.0.1:8002/status > /dev/null; do
  sleep 2
done

echo "✅ Valhalla is running"

# Start backend in a new Terminal window
osascript <<EOF
tell application "Terminal"
    do script "cd ~/runshape/backend && npm run dev"
end tell
EOF

# Start Expo in another Terminal window
osascript <<EOF
tell application "Terminal"
    do script "cd ~/runshape && npx expo start"
end tell
EOF

echo "🎉 ShapeRunr is ready!"

