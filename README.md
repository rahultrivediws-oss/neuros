# 🧠 NEUROS — All-in-One AI Brain App

5 powerful AI tools in one beautiful app:
- 🎓 Exam Prep — study any topic visually
- 📰 News Intel — understand any news deeply  
- 🎬 Story Builder — build stories & scripts
- 💼 Business Brain — brainstorm & strategize
- 💔 Life Coach — emotional clarity & growth

---

## 🚀 HOW TO RUN ON YOUR COMPUTER

### Step 1 — Install Node.js (ONE TIME ONLY)
- Go to: https://nodejs.org
- Click the green "LTS" button → Download → Install
- Keep clicking Next until done

### Step 2 — Install VS Code (ONE TIME ONLY)  
- Go to: https://code.visualstudio.com
- Download → Install
- This is where you edit your app

### Step 3 — Open this folder
- Open VS Code
- Click "Open Folder" → select this "neuros" folder

### Step 4 — Open Terminal in VS Code
- In VS Code: press Ctrl + ` (the key above Tab)
- A black box opens at the bottom = Terminal

### Step 5 — Type these commands one by one:
```
npm install
```
(Wait 2-3 minutes, it downloads everything)

```
cp .env.example .env
```
(Creates your settings file)

Now open the .env file and paste your API key:
```
REACT_APP_ANTHROPIC_KEY=sk-ant-YOUR-KEY-HERE
```

### Step 6 — Start the app!
```
npm start
```
Browser opens automatically at http://localhost:3000 🎉

---

## 🌍 HOW TO PUT IT ON THE INTERNET (FREE)

### Step 1 — Create GitHub account
- Go to: https://github.com
- Sign up free

### Step 2 — Upload your code
- In GitHub: click "New repository"  
- Name it "neuros"
- Click "uploading an existing file"
- Drag ALL your files in (except node_modules folder)
- Click "Commit changes"

### Step 3 — Deploy on Vercel (FREE)
- Go to: https://vercel.com
- Sign up with your GitHub account
- Click "New Project"
- Select your "neuros" repository
- Click "Environment Variables" → Add:
  - NAME: REACT_APP_ANTHROPIC_KEY
  - VALUE: your sk-ant-... key
- Click "Deploy"
- Wait 2 minutes...
- You get a URL like: neuros-xyz.vercel.app ✅

### Step 4 — Share it!
Send that URL to anyone in the world!

---

## ✏️ HOW TO MAKE CHANGES

Open VS Code → open src/App.js → make changes → save → browser updates instantly!

### Easy things to change:

**Change app name:**
Search for "NEUROS" → replace with your name

**Add new example topics:**
Find `examples: [` in each mode → add your own topics

**Change colors:**
Find the color codes like `#00ffcc` → change to any color
(Use https://colorpicker.me to pick colors)

**Add a new mode:**
Copy one of the mode objects in the MODES array → change the text

---

## 💰 HOW TO MAKE MONEY

1. Add Stripe payments: https://stripe.com (free to set up)
2. Hide the API key in a backend (so users can't steal it)
3. Charge ₹199-999/month per user
4. Market to students, writers, entrepreneurs in India

---

## 📁 FILE STRUCTURE
```
neuros/
├── public/
│   └── index.html        ← The HTML shell
├── src/
│   ├── index.js          ← App entry point
│   └── App.js            ← YOUR ENTIRE APP IS HERE
├── .env                  ← Your secret API key
├── .env.example          ← Template
├── .gitignore            ← Keeps .env safe from GitHub
├── package.json          ← App dependencies
└── README.md             ← This file
```

The ONLY file you need to edit is: **src/App.js**

---

Built with React + Claude AI (Anthropic)
