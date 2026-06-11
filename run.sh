cd "$(dirname "$0")" &&
            PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
            lsof -ti:30141 | xargs kill -9 2>/dev/null; echo "Port cleared" &&
            PATH="$HOME/.nvm/versions/node/v22.13.1/bin:$PATH"
            npm run dev
