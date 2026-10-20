import os
import hashlib
from flask import Flask, request, jsonify

app = Flask(__name__)

# Render handles these values securely
VERIFICATION_TOKEN = os.environ.get("EBAY_VERIFICATION_TOKEN")
ENDPOINT_ID = os.environ.get("EBAY_ENDPOINT_ID")

@app.route('/ebay-webhook', methods=['GET', 'POST'])
def ebay_webhook():
    if request.method == 'GET':
        challenge_code = request.args.get('challenge_code')
        if not challenge_code:
            return "Missing challenge code", 400
            
        m = hashlib.sha256()
        m.update(challenge_code.encode('utf-8'))
        m.update(VERIFICATION_TOKEN.encode('utf-8'))
        m.update(ENDPOINT_ID.encode('utf-8'))
        challenge_response = m.hexdigest()
        
        return jsonify({"challengeResponse": challenge_response}), 200

    if request.method == 'POST':
        return "", 200

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 10000))
    app.run(host='0.0.0.0', port=port)
