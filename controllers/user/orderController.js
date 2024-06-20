const User = require("../../models/userSchema");
const Product = require("../../models/productSchema");
const Address = require("../../models/addressSchema");
const Order = require("../../models/orderSchema");
const mongodb = require("mongodb");
const mongoose = require("mongoose");
const razorpay = require("razorpay");
const env = require("dotenv").config();
const crypto = require("crypto");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const easyinvoice = require("easyinvoice");
const Coupon = require("../../models/couponSchema");
let instance = new razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const getCheckoutPage = async (req, res) => {
  try {
    const user = req.query.userId;
    const findUser = await User.findOne({ _id: user });
    const addressData = await Address.findOne({ userId: user });
    const oid = new mongodb.ObjectId(user);
    const data = await User.aggregate([
      { $match: { _id: oid } },
      { $unwind: "$cart" },
      {
        $project: {
          proId: { $toObjectId: "$cart.productId" },
          quantity: "$cart.quantity",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "proId",
          foreignField: "_id",
          as: "productDetails",
        },
      },
    ]);

    const grandTotal = await User.aggregate([
      { $match: { _id: oid } },
      { $unwind: "$cart" },
      {
        $project: {
          proId: { $toObjectId: "$cart.productId" },
          quantity: "$cart.quantity",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "proId",
          foreignField: "_id",
          as: "productDetails",
        },
      },
      {
        $unwind: "$productDetails", // Unwind the array created by the $lookup stage
      },

      {
        $group: {
          _id: null,
          totalQuantity: { $sum: "$quantity" },
          totalPrice: {
            $sum: { $multiply: ["$quantity", "$productDetails.salePrice"] },
          },
        },
      },
    ]);
    const gTotal = req.session.grandTotal;
    const today = new Date().toISOString();
    const findCoupons = await Coupon.find({
      isList: true,
      createdOn: { $lt: new Date(today) },
      expireOn: { $gt: new Date(today) },
      minimumPrice: { $lt: grandTotal[0].totalPrice },
    });
    if (findUser.cart.length > 0) {
      res.render("checkoutcart", {
        product: data,
        user: findUser,
        isCart: true,
        userAddress: addressData,
        grandTotal: grandTotal[0].totalPrice,
        Coupon: findCoupons,
      });
    } else {
      res.redirect("/shop");
    }
  } catch (error) {
    res.redirect("/pageNotFound");
  }
};

const deleteProduct = async (req, res) => {
  try {
    const id = req.query.id;
    const userId = req.session.user;
    const user = await User.findById(userId);
    const cartIndex = user.cart.findIndex((item) => item.productId == id);
    user.cart.splice(cartIndex, 1);
    await user.save();
    res.redirect("/checkout");
  } catch (error) {
    res.redirect("/pageNotFound");
  }
};



const orderPlaced = async (req, res) => {
  try {
    const { totalPrice, addressId, payment } = req.body;
    const userId = req.session.user;
    const findUser = await User.findOne({ _id: userId });
    if (!findUser) {
      return res.status(404).json({ error: "User not found" });
    }
    const productIds = findUser.cart.map((item) => item.productId);
    const findAddress = await Address.findOne({ userId: userId, "address._id": addressId });
    if (!findAddress) {
      return res.status(404).json({ error: "Address not found" });
    }

    const desiredAddress = findAddress.address.find((item) => item._id.toString() === addressId.toString());
    if (!desiredAddress) {
      return res.status(404).json({ error: "Specific address not found" });
    }
    const findProducts = await Product.find({ _id: { $in: productIds } });
    if (findProducts.length !== productIds.length) {
      return res.status(404).json({ error: "Some products not found" });
    }
    const cartItemQuantities = findUser.cart.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));

    const orderedProducts = findProducts.map((item) => ({
      _id: item._id,
      price: item.salePrice,
      name: item.productName,
      image: item.productImage[0],
      productStatus: "Confirmed",
      quantity: cartItemQuantities.find((cartItem) => cartItem.productId.toString() === item._id.toString()).quantity,
    }));

    //Check if totalPrice is above 1000 and payment method is COD
    if (payment === "cod" && totalPrice > 1000) {
      return res.status(400).json({ error: "Orders above ₹1000 are not allowed for Cash on Delivery (COD)" });
    }


    let newOrder = new Order({
      product: orderedProducts,
      totalPrice: totalPrice,
      address: desiredAddress,
      payment: payment,
      userId: userId,
      status: payment === "razorpay" ? "Failed" : "Confirmed",
      createdOn: Date.now(),
    });
    let orderDone = await newOrder.save();

    await User.updateOne({ _id: userId }, { $set: { cart: [] } });
    for (let orderedProduct of orderedProducts) {
      const product = await Product.findOne({ _id: orderedProduct._id });
      if (product) {
        product.quantity = Math.max(product.quantity - orderedProduct.quantity, 0);
        await product.save();
      }
    }

    // Handle different payment methods
    if (newOrder.payment === "cod") {
      res.json({
        payment: true,
        method: "cod",
        order: orderDone,
        quantity: cartItemQuantities,
        orderId: orderDone._id,
      });
    } else if (newOrder.payment === "wallet") {
      if (newOrder.totalPrice <= findUser.wallet) {
        findUser.wallet -= newOrder.totalPrice;
        findUser.history.push({ amount: newOrder.totalPrice, status: "debit", date: Date.now() });
        await findUser.save();
        res.json({
          payment: true,
          method: "wallet",
          order: orderDone,
          orderId: orderDone._id,
          quantity: cartItemQuantities,
          success: true,
        });
      } else {
        await Order.updateOne({ _id: orderDone._id }, { $set: { status: "Failed" } });
        res.json({ payment: false, method: "wallet", success: false });
      }
    } else if (newOrder.payment === "razorpay") {
      const razorPayGeneratedOrder = await generateOrderRazorpay(orderDone._id, orderDone.totalPrice);
      res.json({
        payment: false,
        method: "razorpay",
        razorPayOrder: razorPayGeneratedOrder,
        order: orderDone,
        quantity: cartItemQuantities,
      });
    }
  } catch (error) {
    console.error("Error processing order:", error);
    res.redirect("/pageNotFound");
  }
};



const getOrderDetailsPage = async (req, res) => {
  try {
    const userId = req.session.user;
    const orderId = req.query.id;
    const findOrder = await Order.findOne({ _id: orderId });
    const findUser = await User.findOne({ _id: userId });
    let totalGrant = 0;
    findOrder.product.map((val) => {
      totalGrant += val.price;
    });

    res.render("orderDetails", {
      orders: findOrder,
      user: findUser,
      totalGrant: totalGrant,
    });
  } catch (error) {
    res.redirect("/pageNotFound");
  }
};
const paymentConfirm = async (req, res) => {
  try {
    await Order.updateOne(
      { _id: req.body.orderId },
      { $set: { status: "Confirmed" } }
    ).then((data) => {
      res.json({ status: true });
    });
  } catch (error) {
    res.redirect("/pageNotFound");
  }
};

const getCartCheckoutPage = async (req, res) => {
  try {
    res.render("checkoutCart");
  } catch (error) {
    res.redirect("/pageNotFound");
  }
};

const changeSingleProductStatus = async (req, res) => {
  const { orderId, singleProductId, status } = req.body;
  const oid = new mongodb.ObjectId(singleProductId);
  const order = await Order.findOne({ _id: orderId });
  const productIndex = order.product.findIndex(
    (product) => product._id.toString() === singleProductId
  );
  const orderedProductDataPrice = order.product[productIndex].price;
  const newPrice = order.totalPrice - orderedProductDataPrice;
  try {
    const filter = {
      _id: orderId,
    };
    const update = {
      $set: {
        "product.$[elem].productStatus": status,
        totalPrice: newPrice,
      },
    };
    const options = {
      arrayFilters: [{ "elem._id": oid }],
    };
    const result = await Order.updateOne(filter, update, options);
    res
      .status(200)
      .json({ message: "Product status updated successfully", result });
  } catch {
    res.redirect("/pageNotFound");
  }
};


const cancelorder = async (req, res) => {
  try {
    const userId = req.session.user;
    const findUser = await User.findOne({ _id: userId });
    console.log(findUser, "findUser1123456");
    if (!findUser) {
      return res.status(404).json({ message: "User not found" });
    }
    const orderId = req.query.orderId;
    const findOrder = await Order.findOne({ _id: orderId });
    console.log(findOrder, "findOrder");
    if (!findOrder) {
      console.log("order is not present");
      return res.status(404).json({ message: "Order not found" });
    }
    if (findOrder.status === "Cancelled") {
      console.log(findOrder.status, "already canceled");
      return res.status(400).json({ message: "Order is already cancelled" });
    }
    // Check if the payment method is "razorpay" or "wallet"
    if (
      (findOrder.payment === "razorpay" || findOrder.payment === "wallet") &&
      findOrder.status === "Confirmed"
    ) {
      // Add the paid amount back to the user's wallet
      console.log("if razorPay , wallet cancel");
      findUser.wallet += findOrder.totalPrice;
      console.log(findUser, "user id");
      await findUser.save();
    }
    // Update the order status to "Cancelled"
    await Order.updateOne({ _id: orderId }, { status: "Canceled" });
    for (const productData of findOrder.product) {
      const productId = productData._id;
      const quantity = productData.quantity;
      const product = await Product.findById(productId);
      if (product) {
        product.quantity += quantity;
        console.log(product, "product");
        await product.save();
      } else if (!product) {
        console.log("nah product");
      }
    }

    res.redirect("/userprofile");
  } catch (error) {
    res.redirect("/pageNotFound");
    res.status(500).json({ message: "Internal server error" });
  }
};

const returnorder = async (req, res) => {
  try {
    const userId = req.session.user;
    const findUser = await User.findOne({ _id: userId });
    if (!findUser) {
      return res.status(404).json({ message: "User not found" });
    }
    const orderId = req.query.orderId;
    const findOrder = await Order.findOne({ _id: orderId });
    console.log(findOrder, "findOrder");
    if (!findOrder) {
      console.log("order is not present");
      return res.status(404).json({ message: "Order not found" });
    }
    if (findOrder.status === "returned") {
      console.log(findOrder.status, "already returned");
      return res.status(400).json({ message: "Order is already returned" });
    }

    await Order.updateOne({ _id: orderId }, { status: "Return Request" });
    res.redirect("/userprofile");
  } catch (error) {
    res.redirect("/pageNotFound");
    res.status(500).json({ message: "Internal server error" });
  }
};

const generateOrderRazorpay = (orderId, total) => {
  return new Promise((resolve, reject) => {
    const options = {
      amount: total * 100,
      currency: "INR",
      receipt: String(orderId),
    };
    instance.orders.create(options, function (err, order) {
      if (err) {
        reject(err);
      } else {
        resolve(order);
      }
    });
  });
};

const verify = (req, res) => {
  let hmac = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET);
  hmac.update(
    `${req.body.payment.razorpay_order_id}|${req.body.payment.razorpay_payment_id}`
  );
  hmac = hmac.digest("hex");
  console.log(hmac,"HMAC");
  console.log(req.body.payment.razorpay_signature,"signature");
  if (hmac === req.body.payment.razorpay_signature) {
    console.log("true");
    res.json({ status: true });
  } else {
    console.log("false");
    res.json({ status: false });
  }
};


const downloadInvoice = async (req, res) => {
  try {
      const orderId = req.params.orderId;
      const order = await Order.findById(orderId).populate('userId');

      if (!order) {
          return res.status(404).send('Order not found');
      }

      const data = {
          "documentTitle": "INVOICE",
          "currency": "INR",
          "taxNotation": "gst",
          "marginTop": 25,
          "marginRight": 25,
          "marginLeft": 25,
          "marginBottom": 25,
          apiKey: process.env.EASYINVOICE_API,
           mode: "development",
           images : {
             logo: "https://firebasestorage.googleapis.com/v0/b/ecommerce-397a7.appspot.com/o/logo.jpg?alt=media&token=07b6be19-1ce8-4797-a3a0-f0eaeaafedad",
           },
          "sender": {
              "company": "Trend Setter",
              "address": "Thrikkakkara",
              "zip": "682021",
              "city": "Kochi",
              "country": "India"
          },
          "client": {
              "company": order.address[0].name,
              "address": order.address[0].landMark + ", " + order.address[0].city,
              "zip": order.address[0].pincode,
              "city": order.address[0].state,
              "country": "India"
          },
         information : {
          "number":order.orderId,
          "date":moment(order.date).format("YYYY-MM-DD HH:mm:ss")
         },
          "products": order.product.map(prod => ({
              "quantity": prod.quantity,
              "description": prod.name || prod.title,
              "tax": 0,
              "price": prod.price
          })),
          "bottomNotice": "Thank you for your business. Your Company Slogan/Notice."
      };

      const result = await easyinvoice.createInvoice(data);
      const invoicePath = path.join(__dirname,"../../public/invoice/",`invoice_${orderId}.pdf`);
      fs.writeFileSync(invoicePath, result.pdf, 'base64');
      res.download(invoicePath, `invoice_${orderId}.pdf`, (err) => {
          if (err) {
              console.error("Error downloading the file", err);
          }
          fs.unlinkSync(invoicePath);
      });
  } catch (error) {
      console.error(error);
      res.status(500).send('An error occurred while generating the invoice');
  }
};






module.exports = {
  getCheckoutPage,
  deleteProduct,
  cancelorder,
  orderPlaced,
  getOrderDetailsPage,
  getCartCheckoutPage,
  verify,
  changeSingleProductStatus,
  paymentConfirm,
  returnorder,
  downloadInvoice
};
