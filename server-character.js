"use strict";
var http = require('http');
var util = require('util');
var qs = require('querystring');

module.exports = {
    // Parses form to store in database and redirects
    submitCharacterForm: function(request, response, db, session) {
        var validate = function(a,b,c,d,e,f,g) {
            return true;
        };
        var body='';
        request.on('data', function (data) {
            body +=data;
        });
        request.on('end', function() {
            var POST =  qs.parse(body);
            // Validate input
            if (validate())
            {
                if (!session['username'])
                    session['username'] = '';
                db.all("SELECT * FROM Characters WHERE c_id = '"+POST['c_id']+"', username = '"+session['username']+"'", function(err, row) {
                    // Update
                    db.run("UPDATE Characters SET name='"+POST['name']+
                        "',hair_type=1,eye_type=1,nose_type=1,mouth_type=1,head_type=1,"+
                        "hair_tint='ffffff',skin_tint='ffffff',eye_tint='ffffff',mouth_tint='ffffff' "+
                        "WHERE c_id="+POST['c_id'],
                    function(){});
                });
            } else {
                // Respond failing server side validation
                response.writeHead(200,{"Content-Type": "application/json"});
                var r = {
                    "result" : false
                };
                var jsonObj = JSON.stringify(r);
                response.end(jsonObj);
            }
        });
    },

    loadCharacter: function (request, response, db, secret) {
        // Check if a session exists
        db.all("SELECT username FROM Sessions WHERE secret = '"+secret+"'", function(err, u_row) {
            // Retrieve logged user's character or show default
            if (u_row[0])
            {
                db.all("SELECT * FROM Characters WHERE username = '"+u_row[0]['username']+"'", function(err, c_row) {
                    // All users must have a character, return character data to client in json format
                    var jsonObj = JSON.stringify(c_row[0]);
                    response.end(jsonObj);
                    console.log("Found character");
                });
            }
            else
            {
                console.log("Guest");
                // Return default character data to client for guests
                var character = {
                    "name"          : "Guest",
                    "hair_type"     : 1,
                    "eye_type"      : 1,
                    "nose_type"     : 1,
                    "mouth_type"    : 1,
                    "head_type"     : 1,
                    "hair_tint"     : "ffffff",
                    "skin_tint"     : "ffffff",
                    "eye_tint"      : "ffffff",
                    "mouth_tint"    : "ffffff"
                };
                var jsonObj = JSON.stringify(character);
                response.end(jsonObj);
            }
        });
    }
}