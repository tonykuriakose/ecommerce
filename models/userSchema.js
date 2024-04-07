const Mongoose = require("mongoose");

const userSchema = Mongoose.Schema({
    name : {
        type : String,
        required : true
    },
    email : {
        type : String,
        required : true,
        unique : true
    },
    phone : {
        type : String,
        required : true,
        // unique : true
    },
    password : {
        type : String,
        required : true,
    },
    createdOn : {
        type : String
    },
    isBlocked : {
        type : Boolean,
        default : false
    },
    isAdmin : {
        type : Boolean,
        default : false
    },
    cart : {
        type : Array
    },
    wallet : {
        type : Number,
        default : 0
    },
    history : {
        type : Array
    }
})

const User = Mongoose.model('User',userSchema);
module.exports = User;